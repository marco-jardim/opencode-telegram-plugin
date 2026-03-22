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
  effortCommand,
  statusCommand,
  abortCommand,
  shellCommand,
  diffCommand,
  pendingCommand,
  messagesCommand,
  ocUndoCommand,
  ocRedoCommand,
  ocCompactCommand,
  ocShareCommand,
  commandsCommand,
  ocGenericCommand,
  discoverCommands,
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
  /** Optional error logger; defaults to console.error if not provided. */
  onError?: (message: string, error: unknown) => void;
}

/**
 * Create and configure the grammY bot instance.
 *
 * This does **not** start polling — call `bot.start()` separately with an
 * `AbortSignal` so the lifecycle is controlled by the plugin entry point.
 */
export function createBot(opts: CreateBotOptions): Bot {
  const { token, allowedUsers, onError } = opts;
  const logError = onError ?? ((msg, err) => console.error(msg, err));
  const bot = new Bot(token);

  // ── Auto-retry plugin (handles 429 / 500 transparently) ─────────────────
  bot.api.config.use(autoRetry());

  // ── Global error handler — prevents unhandled errors from killing the bot
  bot.catch((err) => {
    logError("[telegram-plugin] Unhandled error in middleware:", err.error);
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
  bot.command("effort", effortCommand);
  bot.command("status", statusCommand);
  bot.command("abort", abortCommand);
  bot.command("shell", shellCommand);
  bot.command("diff", diffCommand);
  bot.command("pending", pendingCommand);
  bot.command("messages", messagesCommand);
  bot.command("oc_undo", ocUndoCommand);
  bot.command("oc_redo", ocRedoCommand);
  bot.command("oc_compact", ocCompactCommand);
  bot.command("oc_share", ocShareCommand);
  bot.command("commands", commandsCommand);

  // ── Dynamic /oc_* catch-all for custom OpenCode commands ──────────────
  bot.hears(/^\/oc_(\w+)(?:\s+(.*))?$/, async (ctx) => {
    const match = ctx.match;
    const commandName = match[1]!;
    // Skip commands we handle explicitly
    if (["undo", "redo", "compact", "share"].includes(commandName)) return;
    // Inject the arguments as ctx.match for ocGenericCommand
    (ctx as any).match = match[2] ?? "";
    await ocGenericCommand(commandName, ctx);
  });

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
// Bot menu registration
// ---------------------------------------------------------------------------

/**
 * Register all bot commands in Telegram's command menu.
 * Also auto-discovers custom OpenCode commands and registers them as /oc_*.
 */
export async function registerBotMenu(bot: Bot): Promise<void> {
  const builtinCommands = [
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
    { command: "attach", description: "Attach to a session" },
    { command: "detach", description: "Detach from session" },
    { command: "new", description: "Create new session" },
    { command: "sessions", description: "List sessions" },
    { command: "switch", description: "Switch session" },
    { command: "model", description: "List/set model" },
    { command: "effort", description: "Set reasoning effort" },
    { command: "status", description: "Show bot status" },
    { command: "abort", description: "Abort current operation" },
    { command: "shell", description: "Run shell command" },
    { command: "diff", description: "Show changed files" },
    { command: "pending", description: "List pending permissions" },
    { command: "messages", description: "Show recent messages" },
    { command: "oc_undo", description: "Undo last changes" },
    { command: "oc_redo", description: "Redo undone changes" },
    { command: "oc_compact", description: "Compact/summarize session" },
    { command: "oc_share", description: "Share session URL" },
    { command: "commands", description: "List OpenCode commands" },
  ];

  // Auto-discover custom OpenCode commands
  try {
    const ocCommands = await discoverCommands();
    const builtinNames = new Set(["undo", "redo", "compact", "share"]);
    for (const cmd of ocCommands) {
      if (builtinNames.has(cmd.name)) continue; // already registered explicitly
      builtinCommands.push({
        command: `oc_${cmd.name}`,
        description: cmd.description?.slice(0, 256) ?? `OpenCode: ${cmd.name}`,
      });
    }
  } catch {
    // Non-fatal — proceed with builtin commands only
  }

  // Telegram limits to 100 commands
  const commands = builtinCommands.slice(0, 100);

  try {
    await bot.api.setMyCommands(commands);
  } catch {
    // Non-fatal — menu registration failure shouldn't block startup
  }
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
