import type { Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createBot, injectClient, registerBotMenu } from "./bot.js";
import { initMapping } from "./state/mapping.js";
import {
  resolveConfig,
  readConfigFile,
  writeConfigFile,
  deleteConfigKey,
  getConfigStatus,
  getConfigPath,
} from "./config.js";

import {
  handleMessageInfo,
  handlePartUpdated,
  handlePartDelta,
  type HookContext,
  type MessageUpdatedEvent,
  type PartUpdatedEvent,
  type PartDeltaEvent,
} from "./hooks/message.js";
import {
  handleSessionCreated,
  handleSessionIdle,
  handleSessionError,
  handleSessionStatus,
} from "./hooks/session.js";
import { handlePermissionAsked, handlePermissionUpdated } from "./hooks/permission.js";
import { handleToolBefore, handleToolAfter, handleToolPartUpdated, handleFileEdited } from "./hooks/tool.js";

// ---------------------------------------------------------------------------
// /telegram slash command handler
// ---------------------------------------------------------------------------

function handleTelegramCommand(args: string | undefined): string {
  const raw = (args ?? "").trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || "help").toLowerCase();
  const rest = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "set-token": {
      if (!rest) {
        return "**Usage**: `/telegram set-token <BOT_TOKEN>`\n\nGet a token from @BotFather on Telegram.";
      }
      // Basic validation: Telegram tokens are roughly <digits>:<alphanumeric+_->
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(rest)) {
        return "**Invalid token format.** Expected format: `123456789:ABCdef-GHIjkl_MNOpqr`\n\nGet a token from @BotFather on Telegram.";
      }
      writeConfigFile({ botToken: rest });
      const masked = rest.slice(0, 6) + "..." + rest.slice(-4);
      return "**Bot token saved** to config file.\n\n- Token: `" + masked + "`\n- File: `" + getConfigPath() + "`\n\n**Restart OpenCode** for the change to take effect.";
    }

    case "remove-token": {
      deleteConfigKey("botToken");
      return "**Bot token removed** from config file.\n\n**Restart OpenCode** for the change to take effect.";
    }

    case "set-users": {
      if (!rest) {
        return "**Usage**: `/telegram set-users <user_id1,user_id2,...>`\n\nSet comma-separated Telegram user IDs that are allowed to use the bot.\nUse `/telegram remove-users` to allow all users.";
      }
      // Validate: all parts should be numeric
      const ids = rest.split(",").map(s => s.trim()).filter(Boolean);
      const invalid = ids.filter(id => !/^\d+$/.test(id));
      if (invalid.length > 0) {
        return "**Invalid user ID(s)**: " + invalid.map(id => "`" + id + "`").join(", ") + "\n\nUser IDs must be numeric. Message @jsondumpbot on Telegram to get your ID (look for the `from.id` field).";
      }
      writeConfigFile({ allowedUsers: ids.join(",") });
      return "**Allowed users saved**: " + ids.map(id => "`" + id + "`").join(", ") + "\n\n**Restart OpenCode** for the change to take effect.";
    }

    case "remove-users": {
      deleteConfigKey("allowedUsers");
      return "**User restriction removed.** All users will be allowed.\n\n**Restart OpenCode** for the change to take effect.";
    }

    case "set-interval": {
      const ms = Number(rest);
      if (!rest || !Number.isFinite(ms) || ms <= 0) {
        return "**Usage**: `/telegram set-interval <milliseconds>`\n\nSet the minimum interval between message edits during streaming.\nDefault: `2500` (2.5 seconds).";
      }
      writeConfigFile({ editIntervalMs: ms });
      return "**Edit interval saved**: `" + ms + "ms`\n\n**Restart OpenCode** for the change to take effect.";
    }

    case "auto-attach": {
      if (rest === "on" || rest === "true") {
        writeConfigFile({ autoAttach: true });
        return "**Auto-attach enabled.** Bot will auto-attach to the active session on `/start`.\n\n**Restart OpenCode** for the change to take effect.";
      } else if (rest === "off" || rest === "false") {
        writeConfigFile({ autoAttach: false });
        return "**Auto-attach disabled.** Use `/attach` manually.\n\n**Restart OpenCode** for the change to take effect.";
      }
      return "**Usage**: `/telegram auto-attach <on|off>`";
    }

    case "status": {
      return getConfigStatus();
    }

    case "path": {
      return "**Config file path**: `" + getConfigPath() + "`";
    }

    case "show": {
      const file = readConfigFile();
      if (Object.keys(file).length === 0) {
        return "**Config file is empty or doesn't exist.**\n\nPath: `" + getConfigPath() + "`\nUse `/telegram set-token <TOKEN>` to get started.";
      }
      // Mask the token for display
      const display: Record<string, unknown> = { ...file };
      if (typeof display.botToken === "string") {
        const t = display.botToken as string;
        display.botToken = t.slice(0, 6) + "..." + t.slice(-4);
      }
      return "**Config file contents** (`" + getConfigPath() + "`):\n\n```json\n" + JSON.stringify(display, null, 2) + "\n```";
    }

    case "help":
    default: {
      return [
        "**Telegram Plugin Configuration**\n",
        "**Commands**:",
        "- `/telegram set-token <TOKEN>` — Save bot token (from @BotFather)",
        "- `/telegram remove-token` — Remove saved bot token",
        "- `/telegram set-users <id1,id2>` — Restrict bot to specific user IDs",
        "- `/telegram remove-users` — Allow all users",
        "- `/telegram set-interval <ms>` — Set edit throttle interval (default: 2500)",
        "- `/telegram auto-attach <on|off>` — Toggle auto-attach on /start",
        "- `/telegram status` — Show resolved config (file + env)",
        "- `/telegram show` — Show raw config file contents",
        "- `/telegram path` — Show config file location",
        "- `/telegram help` — Show this help\n",
        "**Config file**: `~/.config/opencode/telegram.json`",
        "**Priority**: env vars override config file values.\n",
        "**Quick start**:",
        "1. `/telegram set-token 123456:ABC-DEF...`",
        "2. `/telegram set-users <your_telegram_id>`",
        "3. Restart OpenCode",
      ].join("\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const TelegramPlugin: Plugin = async (ctx) => {
  const { client, directory, serverUrl } = ctx;

  // ── Create v2 SDK client (flat params, agent optional on shell) ─────────
  // Strategy: extract the working baseUrl from the v1 client's HTTP config,
  // try serverUrl.href, and fall back to localhost:4096.
  let baseUrl: string = "";

  // 1. Try v1 client's internal HTTP client config (most reliable)
  try {
    const v1Config = (client as any)?._client?.getConfig?.();
    if (v1Config?.baseUrl && typeof v1Config.baseUrl === "string") {
      baseUrl = v1Config.baseUrl;
    }
  } catch {
    // ignored
  }

  // 2. Try serverUrl (URL object from plugin context)
  if (!baseUrl) {
    try {
      if (typeof serverUrl === "object" && "href" in serverUrl) {
        // Use href (full URL) and strip trailing slash
        baseUrl = String(serverUrl.href).replace(/\/$/, "");
      } else if (typeof serverUrl === "string") {
        baseUrl = serverUrl.replace(/\/$/, "");
      } else {
        baseUrl = String(serverUrl).replace(/\/$/, "");
      }
    } catch {
      // ignored
    }
  }

  // 3. Final fallback
  if (!baseUrl) {
    baseUrl = "http://localhost:4096";
  }

  const v2 = createOpencodeClient({
    baseUrl,
    directory,
  });

  // ── Resolve configuration (config file + env vars) ─────────────────────
  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await v2.app.log({
      service: "telegram-plugin",
      level: "error",
      message: "Failed to resolve config: " + msg,
    });
    return {};
  }

  if (!config.botToken) {
    await v2.app.log({
      service: "telegram-plugin",
      level: "warn",
      message:
        "No bot token found (env or config file) — Telegram bot disabled. Use /telegram set-token to configure.",
    });

    // Even without a token, register the /telegram command so users can configure
    return {
      config: async (opencodeConfig: any) => {
        opencodeConfig.command ??= {};
        opencodeConfig.command["telegram"] = {
          template: "$ARGUMENTS",
          description: "Configure the Telegram plugin (set-token, set-users, status, help)",
        };
      },
      "command.execute.before": async (input: any, output: any) => {
        if (input.command === "telegram") {
          output.parts.push({
            type: "text" as const,
            text: handleTelegramCommand(input.arguments),
          });
        }
      },
    };
  }

  // ── Persistent mapping store ──────────────────────────────────────────
  const dataDir = directory + "/.opencode/telegram";
  try {
    initMapping(dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await v2.app.log({
      service: "telegram-plugin",
      level: "error",
      message: "Failed to init mapping store: " + msg,
    });
  }

  // ── Create bot ────────────────────────────────────────────────────────
  const maskedToken = config.botToken.slice(0, 6) + "..." + config.botToken.slice(-4);
  await v2.app.log({
    service: "telegram-plugin",
    level: "info",
    message: "Initializing Telegram bot (token: " + maskedToken + ", source: " + config.tokenSource + ", allowed_users: " + (config.allowedUsers || "all") + ", baseUrl: " + baseUrl + ")",
  });

  let bot: ReturnType<typeof createBot>;
  try {
    bot = createBot({
      token: config.botToken,
      allowedUsers: config.allowedUsers,
      onError: (message, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        void v2.app.log({
          service: "telegram-plugin",
          level: "error",
          message: message + " " + detail,
        });
      },
    });
    injectClient(v2, baseUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await v2.app.log({
      service: "telegram-plugin",
      level: "error",
      message: "Failed to create bot: " + msg,
    });
    return {};
  }

  // ── Hook context (shared by all event-driven hooks) ───────────────────
  const hookCtx: HookContext = {
    api: bot.api,
    editIntervalMs: config.editIntervalMs,
  };

  // ── Start polling ─────────────────────────────────────────────────────
  void bot.start({
    drop_pending_updates: true,
    onStart: () => {
      void v2.app.log({
        service: "telegram-plugin",
        level: "info",
        message: "Telegram bot started (token from " + config.tokenSource + ").",
      });

      // Register bot commands in Telegram's menu (non-blocking)
      void registerBotMenu(bot).catch(() => undefined);
    },
    allowed_updates: [
      "message",
      "callback_query",
    ],
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    void v2.app.log({
      service: "telegram-plugin",
      level: "error",
      message: "Telegram bot failed to start: " + msg,
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", shutdown);
    bot.stop().catch(() => undefined);
  }

  process.on("SIGINT", shutdown);

  // ── Return hooks ──────────────────────────────────────────────────────
  return {
    // ── /telegram slash command ────────────────────────────────────────
    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["telegram"] = {
        template: "$ARGUMENTS",
        description: "Configure the Telegram plugin (set-token, set-users, status, help)",
      };
    },

    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "telegram") {
        output.parts.push({
          type: "text" as const,
          text: handleTelegramCommand(input.arguments),
        });
      }
    },

    // ── Event dispatcher ──────────────────────────────────────────────
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (!event.properties || typeof event.properties !== "object") return;

      switch (event.type) {
        // ── Streaming: delta events carry incremental text chunks ──────
        case "message.part.delta":
          handlePartDelta(event as PartDeltaEvent, hookCtx);
          break;

        // ── Part updated: full snapshot of a single part ──────────────
        case "message.part.updated": {
          const partEvent = event as PartUpdatedEvent;
          const partType = partEvent.properties?.part?.type;

          if (partType === "tool") {
            // Route tool parts to the tool handler for rich status display
            handleToolPartUpdated(
              partEvent as Parameters<typeof handleToolPartUpdated>[0],
              hookCtx,
            );
          } else {
            // Text and other parts go to the message streamer
            handlePartUpdated(partEvent, hookCtx);
          }
          break;
        }

        // ── message.updated: metadata — track assistant message IDs
        case "message.updated":
          handleMessageInfo(event as MessageUpdatedEvent);
          break;

        case "session.created":
          handleSessionCreated(
            event as Parameters<typeof handleSessionCreated>[0],
            hookCtx,
          );
          break;

        case "session.idle":
          handleSessionIdle(
            event as Parameters<typeof handleSessionIdle>[0],
            hookCtx,
          );
          break;

        case "session.error":
          handleSessionError(
            event as Parameters<typeof handleSessionError>[0],
            hookCtx,
          );
          break;

        case "session.status":
          handleSessionStatus(
            event as Parameters<typeof handleSessionStatus>[0],
            hookCtx,
          );
          break;

        case "permission.asked":
          handlePermissionAsked(
            event as Parameters<typeof handlePermissionAsked>[0],
            hookCtx,
          );
          break;

        case "permission.updated":
          handlePermissionUpdated(
            event as Parameters<typeof handlePermissionUpdated>[0],
            hookCtx,
          );
          break;

        case "tool.execute.before":
          handleToolBefore(
            event as Parameters<typeof handleToolBefore>[0],
            hookCtx,
          );
          break;

        case "tool.execute.after":
          handleToolAfter(
            event as Parameters<typeof handleToolAfter>[0],
            hookCtx,
          );
          break;

        case "file.edited":
          handleFileEdited(
            event as Parameters<typeof handleFileEdited>[0],
            hookCtx,
          );
          break;

        default:
          break;
      }
    },
  };
};

export default TelegramPlugin;
