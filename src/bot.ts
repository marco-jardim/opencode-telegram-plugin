import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

import {
  startCommand,
  helpCommand,
  attachCommand,
  detachCommand,
  newCommand,
  sessionsCommand,
  switchCommand,
  modelCommand,
  statusCommand,
  abortCommand,
  setClient as setCommandsClient,
} from "./handlers/commands.js";
import {
  handleTextMessage,
  setClient as setMessagesClient,
} from "./handlers/messages.js";
import {
  handleCallback,
  setClient as setCallbacksClient,
} from "./handlers/callbacks.js";
import { cleanExpiredCallbacks } from "./state/store.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CLEANUP_INTERVAL_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Bot factory
// ---------------------------------------------------------------------------

export interface CreateBotOptions {
  /** Telegram Bot API token. */
  token: string;
  /** Comma-separated list of allowed Telegram user IDs (empty = allow all). */
  allowedUsers: string;
}

/**
 * Create and configure the grammY bot instance.
 *
 * This does **not** start polling — call `bot.start()` separately with an
 * `AbortSignal` so the lifecycle is controlled by the plugin entry point.
 */
export function createBot(opts: CreateBotOptions): Bot {
  const { token, allowedUsers } = opts;
  const bot = new Bot(token);

  // ── Auto-retry plugin (handles 429 / 500 transparently) ─────────────────
  bot.api.config.use(autoRetry());

  // ── Global error handler — prevents unhandled errors from killing the bot
  bot.catch((err) => {
    console.error("[telegram-plugin] Unhandled error in middleware:", err.error);
  });

  // ── Middleware: private-chat only ───────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return; // silently drop group messages
    await next();
  });

  // ── Middleware: user whitelist ──────────────────────────────────────────
  const allowedSet = parseAllowedUsers(allowedUsers);
  if (allowedSet.size > 0) {
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId === undefined || !allowedSet.has(userId)) return;
      await next();
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────
  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("attach", attachCommand);
  bot.command("detach", detachCommand);
  bot.command("new", newCommand);
  bot.command("sessions", sessionsCommand);
  bot.command("switch", switchCommand);
  bot.command("model", modelCommand);
  bot.command("status", statusCommand);
  bot.command("abort", abortCommand);

  // ── Callback queries ──────────────────────────────────────────────────
  bot.on("callback_query:data", handleCallback);

  // ── Text messages (must be registered after commands) ──────────────────
  bot.on("message:text", handleTextMessage);

  // ── Periodic cleanup of expired callbacks ─────────────────────────────
  const cleanupTimer = setInterval(cleanExpiredCallbacks, CLEANUP_INTERVAL_MS);
  // Ensure the timer doesn't prevent the Node process from exiting.
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }

  return bot;
}

// ---------------------------------------------------------------------------
// Client injection
// ---------------------------------------------------------------------------

/**
 * Inject the OpenCode SDK client into all handler modules.
 *
 * Must be called once before the bot starts processing updates.
 */
export function injectClient(client: unknown): void {
  setCommandsClient(client);
  setMessagesClient(client);
  setCallbacksClient(client);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAllowedUsers(raw: string): Set<number> {
  const set = new Set<number>();
  if (!raw) return set;

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      set.add(n);
    }
  }
  return set;
}
