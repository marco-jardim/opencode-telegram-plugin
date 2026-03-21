import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getChatState, resetStream, registerCallback } from "../state/store.js";
import {
  getActiveSessionId,
  getMode,
  attachSession,
  detachSession,
  startIndependentSession,
} from "../state/mode.js";
import { setMapping } from "../state/mapping.js";
import { safeSend } from "../utils/safeSend.js";
import { escapeHtml } from "../utils/format.js";

// ---------------------------------------------------------------------------
// Client interface — only the methods used in this file
// ---------------------------------------------------------------------------

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}

interface OpenCodeClient {
  session: {
    list(): Promise<{ data: SessionSummary[] }>;
    create(params: { body: { title: string } }): Promise<{ data: { id: string } }>;
    abort(params: { path: { id: string } }): Promise<boolean>;
  };
  config: {
    get(): Promise<{
      data: {
        providers: Record<string, { models: Record<string, { name: string }> }>;
      };
    }>;
  };
}

let _client: OpenCodeClient | null = null;

export function setClient(client: unknown): void {
  _client = client as OpenCodeClient;
}

function getClient(): OpenCodeClient {
  if (!_client) throw new Error("OpenCode client not initialized");
  return _client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELP_TEXT = `
<b>OpenCode Telegram Bot</b> 🤖

<b>Session Management</b>
/attach [id] — Attach to an existing session (lists sessions if no ID given)
/detach      — Detach from the current session
/new [title] — Create and attach to a new independent session
/switch [id] — Switch to a different session
/sessions    — List all available sessions

<b>While in a Session</b>
Just send a message to prompt OpenCode
/abort       — Abort the current running operation

<b>Info &amp; Config</b>
/model       — Show available AI models
/status      — Show current bot status
/help        — Show this help message
`.trim();

/**
 * Returns sessions sorted newest-first, capped at `limit`.
 */
function sortedSessions(sessions: SessionSummary[], limit = 10): SessionSummary[] {
  return [...sessions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Builds an InlineKeyboard where each button attaches to a session.
 */
function buildSessionKeyboard(sessions: SessionSummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const session of sessions) {
    const label = `${session.title || "Untitled"} (${session.id.slice(0, 8)}…)`;
    const key = registerCallback("attach_session", { sessionId: session.id });
    keyboard.text(label, key).row();
  }
  return keyboard;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function startCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Register the chat mapping (username may be undefined for users with no username)
  setMapping(chatId, { username: ctx.from?.username });

  await safeSend(() =>
    ctx.reply(
      `Welcome to <b>OpenCode Bot</b>! 🤖\n\n` +
        `I give you Telegram access to OpenCode — an AI coding assistant.\n\n` +
        `Send me any message to prompt OpenCode, or use /help to see all commands.`,
      { parse_mode: "HTML" },
    ),
  );

  // Auto-attach to the most recent session when enabled (default: on)
  const autoAttach = process.env["TELEGRAM_AUTO_ATTACH"] !== "false";
  if (!autoAttach) return;

  try {
    const { data: sessions } = await getClient().session.list();
    if (sessions.length === 0) return;

    const latest = sortedSessions(sessions, 1)[0]!;
    attachSession(chatId, latest.id);

    await safeSend(() =>
      ctx.reply(
        `✅ Auto-attached to: <b>${escapeHtml(latest.title || "Untitled")}</b>\n` +
          `<code>${escapeHtml(latest.id)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
  } catch {
    // Auto-attach failure is non-fatal — the user can attach manually
  }
}

export async function helpCommand(ctx: Context): Promise<void> {
  await safeSend(() => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));
}

export async function attachCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = typeof ctx.match === "string" ? ctx.match.trim() : undefined;

  if (sessionId) {
    attachSession(chatId, sessionId);
    await safeSend(() =>
      ctx.reply(
        `✅ Attached to session:\n<code>${escapeHtml(sessionId)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
    return;
  }

  // No session ID provided — show a picker
  try {
    const { data: sessions } = await getClient().session.list();

    if (sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const recent = sortedSessions(sessions);
    const keyboard = buildSessionKeyboard(recent);
    const note =
      sessions.length > 10
        ? ` (showing 10 of ${sessions.length} most recent)`
        : "";

    await safeSend(() =>
      ctx.reply(`Select a session to attach to${note}:`, {
        reply_markup: keyboard,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to list sessions: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function detachCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  detachSession(chatId);
  await safeSend(() =>
    ctx.reply("🔌 Detached. Use /attach or /new to start a session."),
  );
}

export async function newCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const title =
    (typeof ctx.match === "string" ? ctx.match.trim() : "") || "Telegram Session";

  try {
    const { data } = await getClient().session.create({ body: { title } });
    startIndependentSession(chatId, data.id);

    await safeSend(() =>
      ctx.reply(
        `✅ Created new session:\n` +
          `<b>${escapeHtml(title)}</b>\n` +
          `<code>${escapeHtml(data.id)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to create session: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function sessionsCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const { data: sessions } = await getClient().session.list();

    if (sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const activeId = getActiveSessionId(chatId);
    const recent = sortedSessions(sessions);

    const lines = recent.map((s, i) => {
      const active = s.id === activeId ? " ✅" : "";
      const title = escapeHtml(s.title || "Untitled");
      const shortId = escapeHtml(s.id.slice(0, 12));
      return `${i + 1}. <b>${title}</b>${active}\n   <code>${shortId}…</code>`;
    });

    const header =
      sessions.length > 10
        ? `Showing 10 of ${sessions.length} sessions (most recent):\n\n`
        : `<b>${sessions.length} session${sessions.length === 1 ? "" : "s"}:</b>\n\n`;

    await safeSend(() =>
      ctx.reply(header + lines.join("\n\n"), { parse_mode: "HTML" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to list sessions: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function switchCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = typeof ctx.match === "string" ? ctx.match.trim() : undefined;

  if (sessionId) {
    const mode = getMode(chatId);
    // Preserve mode semantics: re-attach if attached, switch independent otherwise
    if (mode === "attached") {
      attachSession(chatId, sessionId);
    } else {
      startIndependentSession(chatId, sessionId);
    }

    await safeSend(() =>
      ctx.reply(
        `✅ Switched to session:\n<code>${escapeHtml(sessionId)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
    return;
  }

  // No ID provided — show a picker (same UX as /attach)
  try {
    const { data: sessions } = await getClient().session.list();

    if (sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const recent = sortedSessions(sessions);
    const keyboard = buildSessionKeyboard(recent);
    const note =
      sessions.length > 10
        ? ` (showing 10 of ${sessions.length} most recent)`
        : "";

    await safeSend(() =>
      ctx.reply(`Select a session to switch to${note}:`, {
        reply_markup: keyboard,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to list sessions: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function modelCommand(ctx: Context): Promise<void> {
  try {
    const { data } = await getClient().config.get();
    const { providers } = data;
    const providerIds = Object.keys(providers ?? {});

    if (providerIds.length === 0) {
      await safeSend(() => ctx.reply("No models configured."));
      return;
    }

    const lines: string[] = [];
    for (const providerId of providerIds) {
      const provider = providers[providerId]!;
      lines.push(`<b>${escapeHtml(providerId)}</b>`);

      const modelIds = Object.keys(provider.models ?? {});
      if (modelIds.length === 0) {
        lines.push("  <i>No models listed</i>");
      } else {
        for (const modelId of modelIds) {
          const model = provider.models[modelId]!;
          lines.push(
            `  • <code>${escapeHtml(modelId)}</code> — ${escapeHtml(model.name)}`,
          );
        }
      }
    }

    await safeSend(() =>
      ctx.reply(`<b>Available Models:</b>\n\n${lines.join("\n")}`, {
        parse_mode: "HTML",
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to fetch models: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function statusCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const mode = getMode(chatId);
  const activeId = getActiveSessionId(chatId);
  const state = getChatState(chatId);

  const modeEmoji: Record<string, string> = {
    attached: "🔗",
    independent: "🆓",
    detached: "🔌",
  };

  const lines = [
    `<b>Bot Status</b>`,
    ``,
    `Mode:    ${modeEmoji[mode] ?? "❓"} <b>${escapeHtml(mode)}</b>`,
    activeId
      ? `Session: <code>${escapeHtml(activeId)}</code>`
      : `Session: <i>none</i>`,
    `Stream:  ${state.stream.state !== "IDLE" && state.stream.state !== "FINAL" ? "⏳ active" : "⬜ idle"}`,
  ];

  await safeSend(() =>
    ctx.reply(lines.join("\n"), { parse_mode: "HTML" }),
  );
}

export async function abortCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const activeId = getActiveSessionId(chatId);
  if (!activeId) {
    await safeSend(() => ctx.reply("No active session to abort."));
    return;
  }

  try {
    await getClient().session.abort({ path: { id: activeId } });
    resetStream(chatId);
    await safeSend(() => ctx.reply("⛔ Aborted."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to abort: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}
