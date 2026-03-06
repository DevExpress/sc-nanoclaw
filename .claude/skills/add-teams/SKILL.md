---
name: add-teams
description: Add Microsoft Teams as a channel. Uses Bot Framework SDK with an embedded HTTP server. Requires an Azure Bot registration and a public endpoint (e.g., ngrok or Azure dev tunnel).
---

# Add Microsoft Teams Channel

This skill adds Microsoft Teams support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `teams` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have an Azure Bot registration?** If yes, collect the App ID and App Password now. If no, we'll create one in Phase 3.

**Important:** Unlike Slack (Socket Mode) or Discord (WebSocket Gateway), Teams bots require an HTTP endpoint reachable from the internet. Ask the user which approach they prefer:

1. **ngrok** — Free tunnel for development (`ngrok http 3978`)
2. **Azure Dev Tunnels** — `devtunnel host -p 3978 --allow-anonymous`
3. **Public server** — NanoClaw running on a server with a public IP/domain
4. **Azure deployment** — Full cloud deployment

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-teams
```

This deterministically:

- Adds `src/channels/teams.ts` (TeamsChannel class with Bot Framework SDK, embedded HTTP server, self-registration via `registerChannel`)
- Adds `src/channels/teams.test.ts` (unit tests)
- Appends `import './teams.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `botbuilder` and `botframework-connector` npm dependencies
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:

- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new teams tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Azure Bot Registration (if needed)

If the user doesn't have an Azure Bot, share [TEAMS_SETUP.md](TEAMS_SETUP.md) which has step-by-step instructions.

Quick summary of what's needed:

1. Create an Azure Bot resource in the Azure Portal
2. Note the **Microsoft App ID** (also called Client ID)
3. Create a **Client Secret** (App Password) under Certificates & Secrets
4. Configure the Messaging Endpoint to point to `https://<your-public-url>/api/messages`
5. Enable the Microsoft Teams channel in the Azure Bot's Channels blade

Wait for the user to provide the App ID and App Password.

### Set up the public endpoint

Based on the user's choice in Phase 1:

**ngrok:**

```bash
ngrok http 3978
```

Copy the `https://...ngrok-free.app` URL. The messaging endpoint will be `https://<ngrok-url>/api/messages`.

**Dev Tunnels:**

```bash
devtunnel host -p 3978 --allow-anonymous
```

Update the Azure Bot's **Messaging Endpoint** with the tunnel URL + `/api/messages`.

### Configure environment

Add to `.env`:

```bash
TEAMS_APP_ID=your-microsoft-app-id
TEAMS_APP_PASSWORD=your-client-secret
TEAMS_PORT=3978
```

`TEAMS_PORT` is optional (defaults to 3978).

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Conversation ID

Tell the user:

> 1. Add the bot to a Teams channel or send it a direct message
> 2. Send any message to the bot — it will appear in the NanoClaw logs
> 3. Check the logs for the conversation JID:
>    ```bash
>    tail -f logs/nanoclaw.log | grep 'teams:'
>    ```
> 4. The JID format is: `teams:<conversation-id>`
>
> Conversation IDs in Teams look like `19:abc123@thread.tacv2` for channels or a long ID for personal chats.

Wait for the user to provide the conversation ID.

### Register the channel

Use the IPC register flow or register directly. The conversation ID, name, and folder name are needed.

For a main channel (responds to all messages):

```typescript
registerGroup('teams:<conversation-id>', {
  name: '<channel-name>',
  folder: 'teams_main',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional channels (trigger-only):

```typescript
registerGroup('teams:<conversation-id>', {
  name: '<channel-name>',
  folder: 'teams_<channel-name>',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Teams channel or DM:
>
> - For main channel: Any message works
> - For non-main: `@<bot-name> hello` (mention the bot)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` are set in `.env` AND synced to `data/env/env`
2. Check the conversation is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'teams:%'"`
3. For non-main channels: message must include @mention of the bot
4. Service is running: `launchctl list | grep nanoclaw`

### Bot not receiving messages

1. Verify the Azure Bot's Messaging Endpoint is correct and reachable: `https://<url>/api/messages`
2. Verify ngrok/tunnel is running and forwarding to the correct port
3. Verify the Microsoft Teams channel is enabled in the Azure Bot resource
4. Check the bot app is installed in the Teams team/chat

### HTTP 401 Unauthorized

1. Verify `TEAMS_APP_ID` matches the Azure Bot's Microsoft App ID
2. Verify `TEAMS_APP_PASSWORD` is the correct client secret (not the secret ID, but the secret value)
3. If you regenerated the secret, update `.env` and restart

### Port conflict

If port 3978 is already in use, set `TEAMS_PORT` to a different value in `.env` and update your tunnel/ngrok accordingly.

### Getting the conversation ID

If the conversation ID is hard to find:

- Check NanoClaw logs after sending a message: `grep 'onChatMetadata' logs/nanoclaw.log`
- In Teams channel URLs, the thread ID is embedded but may not match exactly — the log output is authoritative

## After Setup

The bot is now live. Messages in registered Teams channels/chats will be processed by NanoClaw agents in isolated containers, just like any other channel.

**Note:** If using ngrok with a free plan, the URL changes on restart. You'll need to update the Azure Bot's Messaging Endpoint each time. Consider using a paid ngrok plan (stable subdomain) or Azure Dev Tunnels for persistence.
