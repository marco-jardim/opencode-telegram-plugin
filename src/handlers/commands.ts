import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getChatState, cleanupChatStream, registerCallback, type SelectedModel, type EffortLevel } from "../state/store.js";
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
    providers(): Promise<{
      data: {
        providers: Array<{
          id: string;
          name: string;
          models: Record<string, { id: string; name: string }>;
        }>;
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

<b>Model &amp; Config</b>
/model              — List available models
/model provider/id  — Set active model (e.g. <code>/model anthropic/claude-sonnet-4-20250514</code>)
/model reset        — Reset to default model
/effort [low|medium|high] — Set reasoning effort (default: high)
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
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const arg = typeof ctx.match === "string" ? ctx.match.trim() : "";

  // /model reset — clear override
  if (arg.toLowerCase() === "reset") {
    getChatState(chatId).selectedModel = null;
    await safeSend(() =>
      ctx.reply("✅ Model reset to default.", { parse_mode: "HTML" }),
    );
    return;
  }

  // /model provider/model-id — set model
  if (arg && arg.includes("/")) {
    const slashIdx = arg.indexOf("/");
    const providerID = arg.substring(0, slashIdx);
    const modelID = arg.substring(slashIdx + 1);

    if (!providerID || !modelID) {
      await safeSend(() =>
        ctx.reply("Usage: <code>/model provider/model-id</code>\nExample: <code>/model anthropic/claude-sonnet-4-20250514</code>", { parse_mode: "HTML" }),
      );
      return;
    }

    // Validate against available providers/models
    try {
      const { data } = await getClient().config.providers();
      const providers = data?.providers ?? [];
      const provider = providers.find((p) => p.id === providerID);

      if (!provider) {
        const available = providers.map((p) => p.id).join(", ");
        await safeSend(() =>
          ctx.reply(`❌ Unknown provider: <code>${escapeHtml(providerID)}</code>\nAvailable: ${available}`, { parse_mode: "HTML" }),
        );
        return;
      }

      const model = (provider.models ?? {})[modelID];
      if (!model) {
        const available = Object.keys(provider.models ?? {}).slice(0, 10).join("\n  • ");
        await safeSend(() =>
          ctx.reply(
            `❌ Unknown model: <code>${escapeHtml(modelID)}</code>\n\n` +
              `Available models for <b>${escapeHtml(provider.name || provider.id)}</b>:\n  • ${available}`,
            { parse_mode: "HTML" },
          ),
        );
        return;
      }

      const selected: SelectedModel = {
        providerID,
        modelID,
        displayName: model.name ?? modelID,
      };
      getChatState(chatId).selectedModel = selected;

      await safeSend(() =>
        ctx.reply(
          `✅ Model set to:\n<b>${escapeHtml(selected.displayName)}</b>\n<code>${escapeHtml(providerID)}/${escapeHtml(modelID)}</code>`,
          { parse_mode: "HTML" },
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await safeSend(() =>
        ctx.reply(`❌ Failed to validate model: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
      );
    }
    return;
  }

  // /model (no args) — list available models
  try {
    const result = await getClient().config.providers();
    const { data } = result;

    // Diagnostic: show the "default" field
    const defaultField = (data as any)?.default;
    if (defaultField) {
      await safeSend(() =>
        ctx.reply(`[DIAG] default: ${JSON.stringify(defaultField, null, 2)?.substring(0, 1000)}`, { parse_mode: undefined }),
      );
    }

    const providers = data?.providers ?? [];

    if (providers.length === 0) {
      await safeSend(() => ctx.reply("No models configured."));
      return;
    }

    const blocks: string[] = [];
    for (const provider of providers) {
      const modelEntries = Object.entries(provider.models ?? {});
      if (modelEntries.length === 0) continue;

      const modelLines = modelEntries.map(
        ([id, model]) =>
          `  • <code>${escapeHtml(id)}</code> — ${escapeHtml(model.name ?? id)}`,
      );
      blocks.push(
        `<b>${escapeHtml(provider.name || provider.id)}</b>\n${modelLines.join("\n")}`,
      );
    }

    if (blocks.length === 0) {
      await safeSend(() => ctx.reply("No models available."));
      return;
    }

    // Show current selection
    const state = getChatState(chatId);
    const currentLine = state.selectedModel
      ? `\nCurrent: <b>${escapeHtml(state.selectedModel.displayName)}</b> (<code>${escapeHtml(state.selectedModel.providerID)}/${escapeHtml(state.selectedModel.modelID)}</code>)\n`
      : "\nCurrent: <i>default</i>\n";

    const MAX_LEN = 4000;
    let current = `<b>Available Models:</b>${currentLine}\nUse <code>/model provider/model-id</code> to set.\n`;
    for (const block of blocks) {
      if (current.length + block.length + 2 > MAX_LEN) {
        await safeSend(() =>
          ctx.reply(current, { parse_mode: "HTML" }),
        );
        current = "";
      }
      current += "\n" + block + "\n";
    }
    if (current.trim()) {
      await safeSend(() =>
        ctx.reply(current, { parse_mode: "HTML" }),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to fetch models: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

export async function effortCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const arg = typeof ctx.match === "string" ? ctx.match.trim().toLowerCase() : "";
  const state = getChatState(chatId);

  if (!arg) {
    await safeSend(() =>
      ctx.reply(
        `Current effort: <b>${escapeHtml(state.effort)}</b>\n\nUsage: <code>/effort low|medium|high</code>`,
        { parse_mode: "HTML" },
      ),
    );
    return;
  }

  const validEfforts: EffortLevel[] = ["low", "medium", "high"];
  if (!validEfforts.includes(arg as EffortLevel)) {
    await safeSend(() =>
      ctx.reply(
        `❌ Invalid effort level: <code>${escapeHtml(arg)}</code>\nValid: <code>low</code>, <code>medium</code>, <code>high</code>`,
        { parse_mode: "HTML" },
      ),
    );
    return;
  }

  state.effort = arg as EffortLevel;
  const emoji = { low: "🔋", medium: "⚡", high: "🔥" }[state.effort];
  await safeSend(() =>
    ctx.reply(`${emoji} Effort set to: <b>${escapeHtml(state.effort)}</b>`, { parse_mode: "HTML" }),
  );
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

  const effortEmoji = { low: "🔋", medium: "⚡", high: "🔥" }[state.effort] ?? "❓";
  const modelLine = state.selectedModel
    ? `<code>${escapeHtml(state.selectedModel.providerID)}/${escapeHtml(state.selectedModel.modelID)}</code>`
    : "<i>default</i>";

  const lines = [
    `<b>Bot Status</b>`,
    ``,
    `Mode:    ${modeEmoji[mode] ?? "❓"} <b>${escapeHtml(mode)}</b>`,
    activeId
      ? `Session: <code>${escapeHtml(activeId)}</code>`
      : `Session: <i>none</i>`,
    `Model:   ${modelLine}`,
    `Effort:  ${effortEmoji} <b>${escapeHtml(state.effort)}</b>`,
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
    cleanupChatStream(chatId);
    await safeSend(() => ctx.reply("⛔ Aborted."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to abort: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}
