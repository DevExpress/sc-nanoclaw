import http from 'http';
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  TeamsActivityHandler,
  TeamsInfo,
  ActivityTypes,
  ConversationReference,
} from 'botbuilder';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Teams messages can be up to ~28 KB, but we split at a safe boundary
// to avoid rendering issues in the client.
const MAX_MESSAGE_LENGTH = 4000;

// Default port for the embedded HTTP server that receives Bot Framework
// webhook callbacks. Configurable via TEAMS_PORT in .env.
const DEFAULT_PORT = 3978;

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private adapter: CloudAdapter;
  private server: http.Server | null = null;
  private port: number;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private botId: string | undefined;

  // Store conversation references keyed by JID so we can send proactive
  // messages (responses) outside a turn context.
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  private opts: TeamsChannelOpts;

  constructor(opts: TeamsChannelOpts) {
    this.opts = opts;

    // Read credentials from .env (not process.env — keeps secrets off the
    // environment so they don't leak to child processes, matching NanoClaw's
    // security pattern)
    const env = readEnvFile(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_PORT']);
    const appId = env.TEAMS_APP_ID;
    const appPassword = env.TEAMS_APP_PASSWORD;

    if (!appId || !appPassword) {
      throw new Error(
        'TEAMS_APP_ID and TEAMS_APP_PASSWORD must be set in .env',
      );
    }

    this.botId = appId;
    this.port = parseInt(env.TEAMS_PORT || '', 10) || DEFAULT_PORT;

    // ConfigurationBotFrameworkAuthentication expects an object with
    // MicrosoftAppId / MicrosoftAppPassword keys (same shape as process.env).
    const authConfig = {
      MicrosoftAppId: appId,
      MicrosoftAppPassword: appPassword,
      MicrosoftAppType: 'MultiTenant',
    };
    const auth = new ConfigurationBotFrameworkAuthentication(authConfig as any);
    this.adapter = new CloudAdapter(auth);

    // Catch-all error handler — log and continue
    this.adapter.onTurnError = async (_context, error) => {
      logger.error({ err: error }, 'Teams adapter turn error');
    };
  }

  async connect(): Promise<void> {
    const handler = new NanoClawTeamsHandler(this);

    // Create a minimal HTTP server for the /api/messages endpoint.
    // Bot Framework sends webhook POSTs here; we don't need express/restify.
    this.server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/messages') {
        try {
          await this.adapter.process(req, res, (context) => handler.run(context));
        } catch (err) {
          logger.error({ err }, 'Teams: error processing activity');
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
      } else {
        // Health check / catch-all
        res.writeHead(200);
        res.end('OK');
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Teams bot HTTP server listening');
        this.flushOutgoingQueue();
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error({ err }, 'Teams HTTP server error');
        reject(err);
      });
    });
  }

  /**
   * Called by NanoClawTeamsHandler when a message activity arrives.
   * This is an internal method — not part of the Channel interface.
   */
  async handleIncomingMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Only process message activities
    if (activity.type !== ActivityTypes.Message) return;
    if (!activity.text) return;

    const conversationId = activity.conversation.id;
    const jid = `teams:${conversationId}`;
    const timestamp = activity.timestamp
      ? new Date(activity.timestamp).toISOString()
      : new Date().toISOString();

    // Store conversation reference for proactive messaging
    const ref = TurnContext.getConversationReference(activity);
    this.conversationRefs.set(jid, ref);

    // Determine if this is a group conversation or 1:1
    const isGroup = activity.conversation.isGroup === true ||
      activity.conversation.conversationType === 'channel' ||
      activity.conversation.conversationType === 'groupChat';

    // Determine chat name
    let chatName: string | undefined;
    if (activity.conversation.name) {
      chatName = activity.conversation.name;
    }

    // Always report metadata for group discovery
    this.opts.onChatMetadata(jid, timestamp, chatName, 'teams', isGroup);

    // Sync chat name to DB if available
    if (chatName) {
      updateChatName(jid, chatName);
    }

    // Only deliver full messages for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    // Detect if this is from the bot itself
    const isBotMessage = activity.from?.id === this.botId ||
      activity.from?.role === 'bot';

    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      senderName = activity.from?.name || activity.from?.id || 'unknown';
    }

    // In Teams, @mentions are embedded as <at>BotName</at> entities.
    // Strip the bot mention and prepend trigger pattern if the bot was
    // @mentioned so TRIGGER_PATTERN can match.
    let content = activity.text;
    if (!isBotMessage) {
      // TurnContext.removeRecipientMention strips the bot's @mention
      const cleaned = TurnContext.removeRecipientMention(activity);
      if (cleaned) {
        content = cleaned.trim();
      }
      // If the bot was @mentioned, prepend trigger
      const wasMentioned = activity.entities?.some(
        (e) =>
          e.type === 'mention' &&
          e.mentioned?.id === this.botId,
      );
      if (wasMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(jid, {
      id: activity.id || `teams-${Date.now()}`,
      chat_jid: jid,
      sender: activity.from?.id || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Teams disconnected, message queued',
      );
      return;
    }

    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid },
        'No conversation reference for Teams JID, message queued',
      );
      return;
    }

    try {
      // Split long messages at MAX_MESSAGE_LENGTH boundary
      const chunks =
        text.length <= MAX_MESSAGE_LENGTH
          ? [text]
          : splitText(text, MAX_MESSAGE_LENGTH);

      for (const chunk of chunks) {
        await this.adapter.continueConversationAsync(
          this.botId || '',
          ref as ConversationReference,
          async (turnContext) => {
            await turnContext.sendActivity(chunk);
          },
        );
      }

      logger.info({ jid, length: text.length }, 'Teams message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Teams message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('Teams bot HTTP server stopped');
          resolve();
        });
      });
    }
  }

  // Teams does not expose a typing indicator API for bots in the same way.
  // sendActivity with type 'typing' is supported but we keep this as a no-op
  // for consistency with the Slack channel pattern. Enable if desired.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Teams outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const ref = this.conversationRefs.get(item.jid);
        if (!ref) {
          logger.warn(
            { jid: item.jid },
            'Dropping queued Teams message — no conversation reference',
          );
          continue;
        }
        await this.adapter.continueConversationAsync(
          this.botId || '',
          ref as ConversationReference,
          async (turnContext) => {
            await turnContext.sendActivity(item.text);
          },
        );
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Teams message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Minimal TeamsActivityHandler that forwards message activities
 * to the TeamsChannel instance.
 */
class NanoClawTeamsHandler extends TeamsActivityHandler {
  private channel: TeamsChannel;

  constructor(channel: TeamsChannel) {
    super();
    this.channel = channel;
  }

  async onMessageActivity(context: TurnContext): Promise<void> {
    await this.channel.handleIncomingMessage(context);
  }
}

/**
 * Split text into chunks of maxLen characters.
 */
function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

registerChannel('teams', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD']);
  if (!envVars.TEAMS_APP_ID || !envVars.TEAMS_APP_PASSWORD) {
    logger.warn('Teams: TEAMS_APP_ID or TEAMS_APP_PASSWORD not set');
    return null;
  }
  return new TeamsChannel(opts);
});
