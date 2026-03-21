import type { Plugin } from "@opencode-ai/plugin";

import { createBot, injectClient } from "./bot.js";
import { initMapping } from "./state/mapping.js";

import { handleMessageUpdated, type HookContext } from "./hooks/message.js";
import {
  handleSessionCreated,
  handleSessionIdle,
  handleSessionError,
  handleSessionStatus,
} from "./hooks/session.js";
import { handlePermissionAsked } from "./hooks/permission.js";
import { handleToolBefore, handleToolAfter } from "./hooks/tool.js";

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const TelegramPlugin: Plugin = async (ctx) => {
  const { client, directory } = ctx;

  // ── Configuration from environment ────────────────────────────────────
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    await client.app.log({
      body: {
        service: "telegram-plugin",
        level: "warn",
        message:
          "TELEGRAM_BOT_TOKEN not set — Telegram plugin disabled.",
      },
    });
    return {};
  }

  const allowedUsers = process.env["TELEGRAM_ALLOWED_USERS"] ?? "";
  const editIntervalMs = Number(process.env["TELEGRAM_EDIT_INTERVAL_MS"]) || 2500;

  // ── Persistent mapping store ──────────────────────────────────────────
  const dataDir = `${directory}/.opencode/telegram`;
  initMapping(dataDir);

  // ── Create bot ────────────────────────────────────────────────────────
  const bot = createBot({ token, allowedUsers });
  injectClient(client);

  // ── Hook context (shared by all event-driven hooks) ───────────────────
  const hookCtx: HookContext = {
    api: bot.api,
    editIntervalMs,
  };

  // ── Start polling ─────────────────────────────────────────────────────
  // Start in the background — don't await (it blocks until stopped).
  void bot.start({
    drop_pending_updates: true,
    onStart: () => {
      void client.app.log({
        body: {
          service: "telegram-plugin",
          level: "info",
          message: "Telegram bot started (long polling).",
        },
      });
    },
    allowed_updates: [
      "message",
      "callback_query",
    ],
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    bot.stop().catch(() => undefined);
  }

  process.on("SIGINT", shutdown);

  // ── Event dispatcher ──────────────────────────────────────────────────
  return {
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (!event.properties || typeof event.properties !== "object") return;
      const props = event.properties as Record<string, unknown>;

      switch (event.type) {
        // ── Message streaming ──────────────────────────────────────────
        case "message.updated":
        case "message.part.updated": {
          // Guard: ensure parts is an array before passing to handler
          if (!Array.isArray(props.parts)) break;
          handleMessageUpdated(
            event as Parameters<typeof handleMessageUpdated>[0],
            hookCtx,
          );
          break;
        }

        // ── Session lifecycle ──────────────────────────────────────────
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

        // ── Permissions ────────────────────────────────────────────────
        case "permission.asked":
          handlePermissionAsked(
            event as Parameters<typeof handlePermissionAsked>[0],
            hookCtx,
          );
          break;

        // ── Tool execution ─────────────────────────────────────────────
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

        default:
          // Unhandled event — ignore silently
          break;
      }
    },
  };
};

export default TelegramPlugin;
