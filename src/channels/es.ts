/**
 * ES channel — polls es for tickets and routes them through
 * triage → specialist → review pipeline via NanoClaw agent groups.
 */
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';

const JID_PREFIX = 'es:';
const POLL_INTERVAL = 30_000; // 30s

const SPECIALIST_GROUPS: Record<string, string> = {
  xaf: 'support-specialist-xaf',
  devextreme: 'support-specialist-devextreme',
  general: 'support-specialist-general',
};

export class EsChannel implements Channel {
  name = 'es';

  private connected = false;
  private opts: ChannelOpts;
  private apiBase: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingResponses = new Map<string, (text: string) => void>();
  private processing = false;

  constructor(opts: ChannelOpts, apiBase: string) {
    this.opts = opts;
    this.apiBase = apiBase;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL);
    logger.info({ apiBase: this.apiBase }, 'ES channel connected');
    this.poll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const resolver = this.pendingResponses.get(jid);
    if (resolver) {
      resolver(text);
      this.pendingResponses.delete(jid);
    } else {
      logger.warn({ jid }, 'ES: received message for unknown JID');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    logger.info('ES channel disconnected');
  }

  // --- Pipeline ---

  private async poll() {
    if (this.processing || !this.connected) return;
    this.processing = true;
    try {
      await this.processTriage();
      await this.processSpecialists();
    } catch (err) {
      logger.error({ err }, 'ES poll error');
    } finally {
      this.processing = false;
    }
  }

  /** Pick one ticket from the triage queue and classify it */
  private async processTriage() {
    const tickets = await this.query(
      'SELECT * FROM tickets WHERE category IS NULL AND resolved = 0 ORDER BY created_at ASC LIMIT 1',
    );
    if (!tickets.length) return;

    const ticket = tickets[0];
    logger.info({ streamId: ticket.stream_id }, 'Triaging ticket');

    const prompt = [
      `Classify this support ticket. Stream ID: ${ticket.stream_id}`,
      '',
      `Subject: ${ticket.subject}`,
      `From: ${ticket.from_email}`,
      '',
      ticket.body,
    ].join('\n');

    const response = await this.deliverAndWait(`${JID_PREFIX}triage`, prompt);
    const result = this.parseJson(response);
    if (!result?.category) {
      logger.warn(
        { streamId: ticket.stream_id, response },
        'Triage: failed to parse response',
      );
      return;
    }

    await this.api('POST', '/command', {
      aggregateType: 'ticket',
      streamId: ticket.stream_id,
      command: {
        type: 'ClassifyTicket',
        category: result.category,
        priority: result.priority ?? 'normal',
        confidence: result.confidence ?? 0.5,
      },
    });

    logger.info(
      { streamId: ticket.stream_id, category: result.category },
      'Ticket classified',
    );
  }

  /** Pick one ticket per specialist queue and draft a response */
  private async processSpecialists() {
    for (const [category, groupName] of Object.entries(SPECIALIST_GROUPS)) {
      const tickets = await this.query(
        `SELECT * FROM tickets WHERE category = ? AND draft IS NULL AND resolved = 0 ORDER BY created_at ASC LIMIT 1`,
        [category],
      );
      if (!tickets.length) continue;

      const ticket = tickets[0];
      logger.info(
        { streamId: ticket.stream_id, category },
        'Specialist drafting response',
      );

      const prompt = [
        `Draft a response for this ${category} support ticket. Stream ID: ${ticket.stream_id}`,
        '',
        `Subject: ${ticket.subject}`,
        `From: ${ticket.from_email}`,
        `Category: ${ticket.category}`,
        `Priority: ${ticket.priority}`,
        '',
        ticket.body,
      ].join('\n');

      const jid = `${JID_PREFIX}${groupName}`;
      const response = await this.deliverAndWait(jid, prompt);
      const result = this.parseJson(response);
      if (!result?.draft) {
        logger.warn(
          { streamId: ticket.stream_id, response },
          'Specialist: failed to parse response',
        );
        continue;
      }

      await this.api('POST', '/command', {
        aggregateType: 'ticket',
        streamId: ticket.stream_id,
        command: {
          type: 'DraftResponse',
          draft: result.draft,
          confidence: result.confidence ?? 0.5,
        },
      });

      logger.info(
        { streamId: ticket.stream_id, confidence: result.confidence },
        'Response drafted',
      );

      // Auto-resolve high confidence drafts
      if ((result.confidence ?? 0) >= 0.9) {
        await this.api('POST', '/command', {
          aggregateType: 'ticket',
          streamId: ticket.stream_id,
          command: {
            type: 'ResolveTicket',
            resolvedBy: 'auto',
            autoResolved: true,
          },
        });
        logger.info(
          { streamId: ticket.stream_id },
          'Auto-resolved (high confidence)',
        );
      }
    }
  }

  /** Deliver a prompt to a NanoClaw agent group and wait for the response */
  private deliverAndWait(
    targetJid: string,
    prompt: string,
    timeoutMs = 300_000,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(targetJid);
        reject(new Error(`Timeout waiting for agent response on ${targetJid}`));
      }, timeoutMs);

      this.pendingResponses.set(targetJid, (text: string) => {
        clearTimeout(timer);
        resolve(text);
      });

      this.opts.onMessage(targetJid, {
        id: `es-${Date.now()}`,
        chat_jid: targetJid,
        sender: 'es-pipeline',
        sender_name: 'ES Pipeline',
        content: `@${ASSISTANT_NAME} ${prompt}`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
    });
  }

  /** Query the read model via es */
  private async query(sql: string, params?: unknown[]): Promise<any[]> {
    return this.api('POST', '/query', { sql, params });
  }

  /** Call es HTTP API */
  private async api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const url = `${this.apiBase}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`es ${method} ${path}: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** Try to parse JSON from agent response (may have markdown fences) */
  private parseJson(text: string): any {
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

// Self-register
registerChannel('es', (opts: ChannelOpts) => {
  const env = readEnvFile(['ES_ENABLED', 'ES_URL']);
  if (env.ES_ENABLED !== 'true') {
    logger.info('ES channel disabled (set ES_ENABLED=true in .env)');
    return null;
  }
  const apiBase = env.ES_URL ?? 'http://localhost:3100';
  return new EsChannel(opts, apiBase);
});
