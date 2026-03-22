# opencode-telegram-plugin

Telegram bot plugin for [OpenCode](https://opencode.ai) — remote control and independent sessions from your phone.

## Features

- **Remote Control** — attach to your active TUI session, see streaming responses in real-time, send prompts, and approve/deny permission requests via inline buttons
- **Independent Sessions** — create standalone sessions for async work from your phone
- **Live Streaming** — AI responses stream into Telegram with throttled in-place message edits
- **Permission Handling** — tool permission prompts appear as inline keyboards (Approve / Deny)
- **Tool Status** — see which tools are executing in real-time
- **Multi-session** — switch between sessions, list active sessions, create new ones
- **Config Management** — built-in `/telegram` slash command for setup without leaving OpenCode

## Quick Start

### 1. Install the plugin

**Local install** (recommended for development):

Add to your `opencode.json`:

```json
{
  "plugin": ["/path/to/opencode-telegram-plugin"]
}
```

Then install dependencies:

```bash
cd /path/to/opencode-telegram-plugin
bun install
```

**From npm** (after publishing):

```json
{
  "plugin": ["opencode-telegram-plugin"]
}
```

### 2. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 3. Configure the token

**Option A — Using the `/telegram` slash command** (recommended):

Launch OpenCode and run:

```
/telegram set-token 123456789:ABCdef-GHIjkl_MNOpqr
```

Then restart OpenCode.

**Option B — Environment variable**:

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdef-GHIjkl_MNOpqr"
```

**Option C — Config file** (manually):

Create `~/.config/opencode/telegram.json`:

```json
{
  "botToken": "123456789:ABCdef-GHIjkl_MNOpqr"
}
```

### 4. (Optional) Restrict access

Restrict the bot to your Telegram user ID only. To get your ID, message [@jsondumpbot](https://t.me/jsondumpbot) on Telegram — your ID is in the `from.id` field of the response.

```
/telegram set-users 123456789
```

### 5. Start using it

1. Launch OpenCode — the bot starts automatically
2. Open your bot in Telegram and send `/start`
3. Send a message — it's relayed as a prompt to OpenCode
4. Watch the streaming response appear with live edits

## Configuration

Configuration is resolved by layering **env vars** over the **config file** over **defaults**. Env vars always take priority.

### Config file

Located at `~/.config/opencode/telegram.json`:

```json
{
  "botToken": "123456789:ABCdef...",
  "allowedUsers": "111111,222222",
  "editIntervalMs": 2500,
  "autoAttach": true
}
```

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | — |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated user IDs (empty = all) | `""` |
| `TELEGRAM_EDIT_INTERVAL_MS` | Min interval between message edits (ms) | `2500` |
| `TELEGRAM_AUTO_ATTACH` | Auto-attach to active session on `/start` | `true` |

## `/telegram` Slash Command

Manage configuration from within OpenCode without editing files manually.

| Command | Description |
|---------|-------------|
| `/telegram set-token <TOKEN>` | Save bot token from @BotFather |
| `/telegram remove-token` | Remove saved bot token |
| `/telegram set-users <id1,id2,...>` | Restrict bot to specific Telegram user IDs |
| `/telegram remove-users` | Remove user restriction (allow all) |
| `/telegram set-interval <ms>` | Set edit throttle interval (default: 2500) |
| `/telegram auto-attach <on\|off>` | Toggle auto-attach on `/start` |
| `/telegram status` | Show resolved config (file + env combined) |
| `/telegram show` | Show raw config file contents |
| `/telegram path` | Show config file location |
| `/telegram help` | Show help |

Changes to the config file require an **OpenCode restart** to take effect.

## Telegram Bot Commands

Once the bot is running, these commands are available in Telegram:

| Command | Description |
|---------|-------------|
| `/start` | Initialize bot, auto-attach to active session |
| `/attach` | Attach to an active TUI session (shows picker) |
| `/detach` | Detach from the current session |
| `/new` | Create an independent session |
| `/sessions` | List all sessions |
| `/switch` | Switch to a different session |
| `/model` | List available models with favorites marked |
| `/model <provider/model-id>` | Set a specific model for this chat |
| `/model reset` | Reset to the default model |
| `/effort` | Show current effort level |
| `/effort <low\|medium\|high>` | Set reasoning effort level |
| `/status` | Show current connection status |
| `/abort` | Abort the current session |
| `/help` | Show help |

## How It Works

### Modes

- **Attached** (default) — mirrors an active TUI session. You see what the TUI sees, and your messages are sent as prompts to that session.
- **Independent** — a standalone session created via `/new`. Runs separately from the TUI.
- **Detached** — no active session. Messages are ignored until you `/attach` or `/new`.

### Streaming

AI responses are streamed to Telegram using a state machine:

```
IDLE → PENDING_SEND → SENT → EDITING → FINAL
```

- First chunk is sent as a new message
- Subsequent chunks edit the message in-place (throttled to avoid rate limits)
- Long responses are automatically split into multiple messages (entity-aware HTML chunking at 4096 chars)
- Markdown from the AI is converted to Telegram-safe HTML

### Permissions

When OpenCode requests tool permissions, an inline keyboard appears in Telegram:

```
🔐 Permission requested: bash
Command: git status
[✅ Approve] [❌ Deny]
```

Tapping a button responds to the permission request in OpenCode.

## Project Structure

```
src/
├── index.ts              # Plugin entry — lifecycle, event dispatcher, /telegram command
├── config.ts             # Config file management (~/.config/opencode/telegram.json)
├── bot.ts                # grammY bot creation, middleware, command registration
├── handlers/
│   ├── commands.ts       # Telegram bot command handlers
│   ├── messages.ts       # Text message → prompt relay
│   └── callbacks.ts      # Inline button callback resolution
├── hooks/
│   ├── message.ts        # message.updated → stream to Telegram
│   ├── session.ts        # Session lifecycle notifications
│   ├── permission.ts     # Permission prompts → inline keyboards
│   └── tool.ts           # Tool execution status updates
├── state/
│   ├── store.ts          # Per-chat state, stream tracker, callback registry
│   ├── mode.ts           # Session mode manager
│   └── mapping.ts        # Persistent chat ↔ session mapping
└── utils/
    ├── format.ts         # Markdown → Telegram HTML conversion
    ├── chunk.ts          # Entity-aware message splitting
    ├── throttle.ts       # Edit rate limiter
    ├── safeSend.ts       # Error-classified Telegram API wrapper
    └── typing.ts         # Typing indicator manager
```

## License

[GPL-3.0-or-later](LICENSE)
