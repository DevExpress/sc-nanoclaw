# Microsoft Teams Bot Setup for NanoClaw

Step-by-step guide to creating and configuring an Azure Bot for use with NanoClaw in Microsoft Teams.

## Prerequisites

- An Azure subscription (free tier works)
- A Microsoft 365 tenant with Teams enabled
- Your NanoClaw instance with the `/add-teams` skill applied
- A public endpoint for receiving webhooks (ngrok, dev tunnel, or public server)

## Step 1: Create an Azure Bot Resource

1. Go to the [Azure Portal](https://portal.azure.com)
2. Click **Create a resource**
3. Search for **Azure Bot** and select it
4. Click **Create**
5. Fill in the details:
   - **Bot handle**: A unique name (e.g., `nanoclaw-teams-bot`)
   - **Subscription**: Select your Azure subscription
   - **Resource group**: Create new or use existing
   - **Pricing tier**: Free (F0) is sufficient
   - **Type of App**: **Single Tenant**
   - **Creation type**: **Create new Microsoft App ID**
6. Click **Review + Create**, then **Create**

## Step 2: Get the App ID and Create a Secret

### Get the App ID

1. Navigate to your newly created Azure Bot resource
2. Go to **Configuration** in the left sidebar
3. Copy the **Microsoft App ID** — this is your `TEAMS_APP_ID`

### Get the Tenant ID

1. In the Azure Portal, go to **Microsoft Entra ID** (formerly Azure Active Directory)
2. On the **Overview** page, copy the **Tenant ID** — this is your `TEAMS_TENANT_ID`

> Alternatively, the Tenant ID is visible in the Azure Bot's app registration under **Overview** → **Directory (tenant) ID**.

### Create a Client Secret

1. Click the **Manage Password** link next to the App ID (this opens the Azure AD app registration)
2. In the app registration, go to **Certificates & secrets**
3. Click **New client secret**
4. Enter a description (e.g., `nanoclaw`) and choose an expiration
5. Click **Add**
6. **Copy the secret Value immediately** — it won't be shown again. This is your `TEAMS_APP_PASSWORD`

> ⚠️ Copy the **Value** column, not the **Secret ID** column.

## Step 3: Configure the Messaging Endpoint

The messaging endpoint tells Azure where to send webhook messages when users interact with your bot.

1. Go back to your Azure Bot resource → **Configuration**
2. Set the **Messaging endpoint** to:
   ```
   https://<your-public-url>/api/messages
   ```

### For ngrok (development)

Start ngrok pointing to NanoClaw's Teams port:

```bash
ngrok http 3978
```

Copy the HTTPS forwarding URL (e.g., `https://abc123.ngrok-free.app`) and set the messaging endpoint to:

```
https://abc123.ngrok-free.app/api/messages
```

### For Azure Dev Tunnels

```bash
devtunnel host -p 3978 --allow-anonymous
```

Use the tunnel URL as the messaging endpoint.

### For a public server

Use your server's public URL:

```
https://your-server.example.com:3978/api/messages
```

> **Note:** The endpoint MUST be HTTPS. HTTP endpoints are not accepted by Azure Bot Service.

3. Click **Apply** to save

## Step 4: Enable the Teams Channel

1. In your Azure Bot resource, go to **Channels** in the left sidebar
2. Click **Microsoft Teams** under "Available Channels"
3. Accept the Terms of Service
4. Click **Apply**

The Teams channel should now show as "Running" in the channels list.

## Step 5: Install the Bot in Teams

### Option A: Sideload (development)

1. In Teams, click **Apps** in the left sidebar
2. Click **Manage your apps** → **Upload a custom app** (or **Upload an app to your org's app catalog**)
3. Create a `manifest.json` for your bot (see below) and zip it with two icon files
4. Upload the zip file

**Minimal manifest.json:**

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<your-TEAMS_APP_ID>",
  "developer": {
    "name": "NanoClaw",
    "websiteUrl": "https://nanoclaw.dev",
    "privacyUrl": "https://nanoclaw.dev/privacy",
    "termsOfUseUrl": "https://nanoclaw.dev/terms"
  },
  "name": {
    "short": "NanoClaw",
    "full": "NanoClaw AI Assistant"
  },
  "description": {
    "short": "AI assistant powered by NanoClaw",
    "full": "A personal AI assistant running in isolated containers"
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "bots": [
    {
      "botId": "<your-TEAMS_APP_ID>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": false,
      "isNotificationOnly": false,
      "commandLists": []
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

Replace `<your-TEAMS_APP_ID>` with your actual App ID. Create two PNG icons:

- `color.png` — 192×192 full-color icon
- `outline.png` — 32×32 transparent outline icon

Zip these three files together and upload.

### Option B: Add via Bot Framework (quick test)

1. Go to [Microsoft Teams Web](https://teams.microsoft.com)
2. In the chat search, search for your bot by its App ID or name
3. Start a conversation with it

## Step 6: Configure NanoClaw

Add your credentials to `.env`:

```
TEAMS_APP_ID=<your-microsoft-app-id>
TEAMS_APP_PASSWORD=<your-client-secret>
TEAMS_TENANT_ID=<your-tenant-id>
TEAMS_PORT=3978
```

`TEAMS_PORT` is optional and defaults to 3978.

Sync to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Step 7: Add the Bot to Channels

For channel conversations (not just 1:1 DMs):

1. Open the Teams channel where you want the bot
2. Click the **+** button to add a tab, or right-click the channel
3. Search for your bot app and add it
4. The bot will now receive messages when @mentioned in that channel

## Token Reference

| Credential                         | Where to find it                                           |
| ---------------------------------- | ---------------------------------------------------------- |
| Microsoft App ID (TEAMS_APP_ID)    | Azure Bot → Configuration → Microsoft App ID               |
| Client Secret (TEAMS_APP_PASSWORD) | Azure AD App Registration → Certificates & secrets → Value |
| Tenant ID (TEAMS_TENANT_ID)        | Microsoft Entra ID → Overview → Tenant ID                  |

## Troubleshooting

**Bot not receiving messages:**

- Verify the Messaging Endpoint is correct and uses HTTPS
- Verify ngrok/tunnel is running and forwarding to the right port
- Verify the Teams channel is enabled in Azure Bot → Channels

**HTTP 401 errors in logs:**

- The App ID and App Password don't match
- Copy the secret **Value**, not the **Secret ID**
- If the secret expired, create a new one and update `.env`

**"Bot is not reachable" in Teams:**

- The messaging endpoint is down or unreachable
- Start ngrok/tunnel before testing
- Check that NanoClaw is running and the HTTP server started on the correct port

**Bot works in 1:1 but not in channels:**

- The bot must be explicitly added to the channel
- In channels, users must @mention the bot to trigger it

**ngrok URL changed:**

- Free ngrok URLs change on restart
- Update Azure Bot → Configuration → Messaging Endpoint with the new URL
- Consider a paid ngrok plan or Azure Dev Tunnels for a stable URL
