import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// --- botbuilder mock ---

const adapterRef = vi.hoisted(() => ({
  processHandler: null as any,
  onTurnError: null as any,
  continueConversationCalls: [] as any[],
}));

vi.mock('botbuilder', () => {
  class MockCloudAdapter {
    onTurnError: any;

    constructor() {
      adapterRef.onTurnError = null;
    }

    async process(req: any, res: any, logic: any) {
      adapterRef.processHandler = logic;
      await logic(req._turnContext);
      if (res && !res.headersSent) {
        res.writeHead(200);
        res.end();
      }
    }

    async continueConversationAsync(
      botId: string,
      ref: any,
      callback: any,
    ) {
      const mockContext = {
        sendActivity: vi.fn().mockResolvedValue(undefined),
      };
      adapterRef.continueConversationCalls.push({ botId, ref, callback });
      await callback(mockContext);
      return mockContext;
    }
  }

  class MockConfigurationBotFrameworkAuthentication {
    constructor(_config: any) {}
  }

  class MockTurnContext {
    static getConversationReference(activity: any) {
      return {
        conversation: activity.conversation,
        serviceUrl: activity.serviceUrl || 'https://smba.trafficmanager.net/teams/',
        channelId: 'msteams',
        bot: { id: 'bot-id', name: 'Bot' },
      };
    }

    static removeRecipientMention(activity: any) {
      if (!activity.text) return activity.text;
      // Simple mock: strip <at>BotName</at> patterns
      return activity.text.replace(/<at>[^<]*<\/at>\s*/g, '').trim();
    }
  }

  class MockTeamsActivityHandler {
    async run(context: any) {
      if (context.activity?.type === 'message') {
        await this.onMessageActivity(context);
      }
    }
    async onMessageActivity(_context: any): Promise<void> {}
  }

  return {
    CloudAdapter: MockCloudAdapter,
    ConfigurationBotFrameworkAuthentication: MockConfigurationBotFrameworkAuthentication,
    TurnContext: MockTurnContext,
    TeamsActivityHandler: MockTeamsActivityHandler,
    TeamsInfo: {},
    ActivityTypes: { Message: 'message' },
    ConversationReference: {},
  };
});

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    TEAMS_APP_ID: 'test-app-id',
    TEAMS_APP_PASSWORD: 'test-app-password',
    TEAMS_TENANT_ID: 'test-tenant-id',
    TEAMS_PORT: '0', // Use port 0 for random available port in tests
  }),
}));

import { TeamsChannel, TeamsChannelOpts } from './teams.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TeamsChannelOpts>,
): TeamsChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'teams:19:test-conversation-id@thread.tacv2': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTurnContext(overrides: {
  conversationId?: string;
  conversationType?: string;
  conversationName?: string;
  text?: string;
  fromId?: string;
  fromName?: string;
  fromRole?: string;
  activityId?: string;
  timestamp?: string;
  entities?: any[];
  isGroup?: boolean;
}) {
  const activity = {
    type: 'message',
    id: overrides.activityId ?? 'msg-001',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    timestamp: overrides.timestamp ?? '2024-01-01T00:00:00.000Z',
    conversation: {
      id: overrides.conversationId ?? '19:test-conversation-id@thread.tacv2',
      conversationType: overrides.conversationType ?? 'channel',
      name: overrides.conversationName ?? 'General',
      isGroup: overrides.isGroup ?? true,
    },
    from: {
      id: overrides.fromId ?? 'user-456',
      name: overrides.fromName ?? 'Alice Smith',
      role: overrides.fromRole,
    },
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
    channelId: 'msteams',
    entities: overrides.entities ?? [],
  };

  return {
    activity,
    sendActivity: vi.fn().mockResolvedValue(undefined),
  };
}

// --- Tests ---

describe('TeamsChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterRef.continueConversationCalls = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('starts HTTP server on connect and reports connected', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered conversation', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'Hello everyone' });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:test-conversation-id@thread.tacv2',
        expect.any(String),
        'General',
        'teams',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:test-conversation-id@thread.tacv2',
        expect.objectContaining({
          id: 'msg-001',
          chat_jid: 'teams:19:test-conversation-id@thread.tacv2',
          sender: 'user-456',
          sender_name: 'Alice Smith',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered conversations', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        conversationId: '19:unregistered@thread.tacv2',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:unregistered@thread.tacv2',
        expect.any(String),
        'General',
        'teams',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: undefined as any });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-message activity types', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'hello' });
      ctx.activity.type = 'conversationUpdate';
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('detects bot messages by matching bot ID', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        fromId: 'test-app-id',
        fromName: 'Bot',
        text: 'Self message',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:test-conversation-id@thread.tacv2',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by role', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        fromId: 'other-bot',
        fromRole: 'bot',
        text: 'Bot says hello',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:test-conversation-id@thread.tacv2',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies personal chat as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'teams:personal-chat-id': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        conversationId: 'personal-chat-id',
        conversationType: 'personal',
        isGroup: false,
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:personal-chat-id',
        expect.any(String),
        'General',
        'teams',
        false,
      );
    });

    it('identifies channel conversations as group', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        conversationType: 'channel',
        isGroup: true,
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'teams',
        true,
      );
    });

    it('identifies groupChat conversations as group', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        conversationType: 'groupChat',
        isGroup: false, // conversationType takes precedence
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'teams',
        true,
      );
    });

    it('stores conversation reference for proactive messaging', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'Hello' });
      await channel.handleIncomingMessage(ctx as any);

      // After handling a message, we should be able to send proactively
      // The conversation reference is stored internally
      await channel.connect();
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        'Reply',
      );

      expect(adapterRef.continueConversationCalls.length).toBe(1);
      await channel.disconnect();
    });

    it('uses sender name from activity.from.name', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        fromName: 'Bob Johnson',
        text: 'Hello',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sender_name: 'Bob Johnson',
        }),
      );
    });

    it('falls back to from.id when name is missing', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        fromId: 'user-789',
        fromName: undefined as any,
        text: 'Hello',
      });
      ctx.activity.from.name = undefined as any;
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sender_name: 'user-789',
        }),
      );
    });

    it('updates chat name in DB when conversation name is available', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        conversationName: 'Engineering',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(updateChatName).toHaveBeenCalledWith(
        'teams:19:test-conversation-id@thread.tacv2',
        'Engineering',
      );
    });

    it('converts timestamp to ISO format', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        timestamp: '2024-06-15T10:30:00.000Z',
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timestamp: '2024-06-15T10:30:00.000Z',
        }),
      );
    });

    it('generates fallback activity id when missing', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'Hello' });
      ctx.activity.id = undefined as any;
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          id: expect.stringMatching(/^teams-\d+$/),
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Teams entity', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        text: '<at>Jonesy</at> what do you think?',
        entities: [
          {
            type: 'mention',
            mentioned: { id: 'test-app-id', name: 'Jonesy' },
          },
        ],
      });
      await channel.handleIncomingMessage(ctx as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '@Jonesy what do you think?',
        }),
      );
    });

    it('does not double-prepend trigger when already present', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        text: '@Jonesy <at>Jonesy</at> hello',
        entities: [
          {
            type: 'mention',
            mentioned: { id: 'test-app-id', name: 'Jonesy' },
          },
        ],
      });
      await channel.handleIncomingMessage(ctx as any);

      // After stripping <at>Jonesy</at>, text starts with @Jonesy
      // so trigger should not be double-prepended
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: expect.stringMatching(/^@Jonesy/),
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        text: 'Echo: <at>Jonesy</at>',
        fromId: 'test-app-id',
        entities: [
          {
            type: 'mention',
            mentioned: { id: 'test-app-id', name: 'Jonesy' },
          },
        ],
      });
      await channel.handleIncomingMessage(ctx as any);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: 'Echo: <at>Jonesy</at>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({
        text: 'Hey <at>OtherUser</at> look at this',
        entities: [
          {
            type: 'mention',
            mentioned: { id: 'other-user-id', name: 'OtherUser' },
          },
        ],
      });
      await channel.handleIncomingMessage(ctx as any);

      // Mention is for a different user, not the bot — no trigger prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: 'Hey look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via continueConversationAsync', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      // First handle a message to store the conversation reference
      const ctx = createTurnContext({ text: 'Hello' });
      await channel.handleIncomingMessage(ctx as any);

      await channel.connect();
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        'Response',
      );

      expect(adapterRef.continueConversationCalls.length).toBe(1);
      expect(adapterRef.continueConversationCalls[0].botId).toBe('test-app-id');

      await channel.disconnect();
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        'Queued message',
      );

      expect(adapterRef.continueConversationCalls.length).toBe(0);
    });

    it('queues message when no conversation reference exists', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();
      // No prior message handled — no conversation reference
      await channel.sendMessage(
        'teams:19:unknown@thread.tacv2',
        'No ref',
      );

      expect(adapterRef.continueConversationCalls.length).toBe(0);

      await channel.disconnect();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      // Store conversation reference
      const ctx = createTurnContext({ text: 'Hello' });
      await channel.handleIncomingMessage(ctx as any);

      await channel.connect();

      const longText = 'A'.repeat(4500);
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        longText,
      );

      // Should be split into 2 calls: 4000 + 500
      expect(adapterRef.continueConversationCalls.length).toBe(2);

      await channel.disconnect();
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'Hello' });
      await channel.handleIncomingMessage(ctx as any);

      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        text,
      );

      expect(adapterRef.continueConversationCalls.length).toBe(1);

      await channel.disconnect();
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const ctx = createTurnContext({ text: 'Hello' });
      await channel.handleIncomingMessage(ctx as any);

      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage(
        'teams:19:test-conversation-id@thread.tacv2',
        longText,
      );

      // 4000 + 4000 + 500 = 3 messages
      expect(adapterRef.continueConversationCalls.length).toBe(3);

      await channel.disconnect();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns teams: JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('teams:19:abc@thread.tacv2')).toBe(true);
    });

    it('owns teams: personal chat JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('teams:personal-chat-id')).toBe(true);
    });

    it('does not own Slack JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('dc:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await expect(
        channel.setTyping('teams:19:abc@thread.tacv2', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await expect(
        channel.setTyping('teams:19:abc@thread.tacv2', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when TEAMS_APP_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        TEAMS_APP_ID: '',
        TEAMS_APP_PASSWORD: 'test-password',
        TEAMS_TENANT_ID: 'test-tenant-id',
        TEAMS_PORT: '3978',
      });

      expect(() => new TeamsChannel(createTestOpts())).toThrow(
        'TEAMS_APP_ID, TEAMS_APP_PASSWORD, and TEAMS_TENANT_ID must be set in .env',
      );
    });

    it('throws when TEAMS_APP_PASSWORD is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        TEAMS_APP_ID: 'test-id',
        TEAMS_APP_PASSWORD: '',
        TEAMS_TENANT_ID: 'test-tenant-id',
        TEAMS_PORT: '3978',
      });

      expect(() => new TeamsChannel(createTestOpts())).toThrow(
        'TEAMS_APP_ID, TEAMS_APP_PASSWORD, and TEAMS_TENANT_ID must be set in .env',
      );
    });

    it('throws when TEAMS_TENANT_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        TEAMS_APP_ID: 'test-id',
        TEAMS_APP_PASSWORD: 'test-password',
        TEAMS_TENANT_ID: '',
        TEAMS_PORT: '3978',
      });

      expect(() => new TeamsChannel(createTestOpts())).toThrow(
        'TEAMS_APP_ID, TEAMS_APP_PASSWORD, and TEAMS_TENANT_ID must be set in .env',
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "teams"', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.name).toBe('teams');
    });
  });
});
