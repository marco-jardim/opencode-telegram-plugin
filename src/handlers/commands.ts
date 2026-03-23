import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
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
// Client — v2 SDK (flat parameter style)
// ---------------------------------------------------------------------------

// V2 Session has time: { created: number, updated: number }, not createdAt
interface V2Session {
  id: string;
  title: string;
  time: { created: number; updated: number };
  share?: { url: string };
  [key: string]: unknown;
}

interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

interface MessageInfo {
  id: string;
  role: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface OpenCodeCommand {
  name: string;
  description?: string;
  source?: string;
}

let _client: OpencodeClient | null = null;

export function setClient(client: OpencodeClient): void {
  _client = client;
}

function getClient(): OpencodeClient {
  if (!_client) throw new Error("OpenCode client not initialized");
  return _client;
}

// ---------------------------------------------------------------------------
// V2 SDK error helper
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable error message from a v2 SDK response.
 * The SDK returns { data, error, request, response } with ThrowOnError=false.
 */
function sdkError(result: { error?: unknown; response?: { status?: number } }): string | null {
  if (!result.error) return null;
  const err = result.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // ConnectionRefused, network errors
    if (e.message) return String(e.message);
    if (e.code) return `${e.code}`;
    // HTTP error with body
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      if (d.message) return String(d.message);
    }
  }
  const status = result.response?.status;
  return status ? `HTTP ${status}` : "Unknown SDK error";
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
<code>!command</code>     — Run a shell command (e.g. <code>!git status</code>)
/shell &lt;cmd&gt; — Run a shell command
/abort       — Abort the current running operation
/diff        — Show changed files in current session
/messages    — Show last 5 messages from session

<b>Model &amp; Config</b>
/model              — List available models
/model provider/id  — Set active model (e.g. <code>/model anthropic/claude-sonnet-4-20250514</code>)
/model reset        — Reset to default model
/effort [low|medium|high] — Set reasoning effort (default: high)
/status      — Show current bot status
/help        — Show this help message

<b>Permissions</b>
Reply <code>YES</code>, <code>NO</code>, or <code>ALWAYS</code> to a permission message
/pending     — List pending permission requests

<b>OpenCode Commands</b>
/oc_undo     — Undo last message + file changes
/oc_redo     — Redo undone changes
/oc_compact  — Summarize/compact the session
/oc_share    — Share the session (get URL)
/commands    — List all available OpenCode commands
`.trim();

/**
 * Returns sessions sorted newest-first, capped at `limit`.
 */
function sortedSessions(sessions: V2Session[], limit = 10): V2Session[] {
  return [...sessions]
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    .slice(0, limit);
}

/**
 * Builds an InlineKeyboard where each button attaches to a session.
 */
function buildSessionKeyboard(sessions: V2Session[]): InlineKeyboard {
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
    const result = await getClient().session.list();
    const errMsg = sdkError(result as any);
    if (errMsg) {
      await safeSend(() =>
        ctx.reply(`⚠️ Auto-attach failed: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" }),
      );
      return;
    }
    const sessions = result.data;
    if (!sessions || sessions.length === 0) return;

    const latest = sortedSessions(sessions as V2Session[], 1)[0]!;
    attachSession(chatId, latest.id);

    await safeSend(() =>
      ctx.reply(
        `✅ Auto-attached to: <b>${escapeHtml(latest.title || "Untitled")}</b>\n` +
          `<code>${escapeHtml(latest.id)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`⚠️ Auto-attach error: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
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
    const result = await getClient().session.list();
    const errMsg = sdkError(result as any);
    if (errMsg) {
      await safeSend(() =>
        ctx.reply(`❌ Failed to list sessions: ${escapeHtml(errMsg)}`, { parse_mode: "HTML" }),
      );
      return;
    }
    const sessions = result.data;
    if (!sessions || sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const recent = sortedSessions(sessions as V2Session[]);
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
    const result = await getClient().session.create({ title });
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const data = result.data;
    if (!data) throw new Error("No session returned");
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
    const result = await getClient().session.list();
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const sessions = result.data;
    if (!sessions || sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const activeId = getActiveSessionId(chatId);
    const recent = sortedSessions(sessions as V2Session[]);

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
    const result = await getClient().session.list();
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const sessions = result.data;
    if (!sessions || sessions.length === 0) {
      await safeSend(() =>
        ctx.reply("No sessions found. Use /new to create one."),
      );
      return;
    }

    const recent = sortedSessions(sessions as V2Session[]);
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

    // Validate provider exists, but allow any model ID (favorites may not be in models list)
    try {
      const result = await getClient().config.providers();
      const errMsg = sdkError(result as any);
      if (errMsg) throw new Error(errMsg);
      const providers = (result.data as any)?.providers ?? [];
      const provider = providers.find((p: any) => p.id === providerID);

      if (!provider) {
        const available = providers.map((p: any) => p.id).join(", ");
        await safeSend(() =>
          ctx.reply(`❌ Unknown provider: <code>${escapeHtml(providerID)}</code>\nAvailable: ${available}`, { parse_mode: "HTML" }),
        );
        return;
      }

      // Try to resolve display name from models list, fall back to raw ID
      const model = (provider.models ?? {})[modelID];
      const displayName = model?.name ?? modelID;

      const selected: SelectedModel = {
        providerID,
        modelID,
        displayName,
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
    const errMsg2 = sdkError(result as any);
    if (errMsg2) throw new Error(errMsg2);
    const data = result.data;
    const providers = (data as any)?.providers ?? [];

    if (providers.length === 0) {
      await safeSend(() => ctx.reply("No models configured."));
      return;
    }

    // Show current selection
    const state = getChatState(chatId);
    const currentLine = state.selectedModel
      ? `Current: <b>${escapeHtml(state.selectedModel.displayName)}</b> (<code>${escapeHtml(state.selectedModel.providerID)}/${escapeHtml(state.selectedModel.modelID)}</code>)`
      : "Current: <i>default</i>";

    // Sort providers alphabetically by display name
    const sorted = [...providers].sort((a: any, b: any) =>
      (a.name || a.id).localeCompare(b.name || b.id),
    );

    // Build per-provider blocks with models sorted alphabetically by name
    const blocks: string[] = [];
    for (const provider of sorted) {
      const modelEntries = Object.entries(provider.models ?? {});
      if (modelEntries.length === 0) continue;

      const modelLines = modelEntries
        .sort(([, a], [, b]) => (a.name ?? "").localeCompare(b.name ?? ""))
        .map(
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

    // Assemble output
    const MAX_LEN = 4000;
    let header = `<b>Available Models:</b>\n${currentLine}\n`;
    header += `\nUse <code>/model provider/model-id</code> to set.\n`;

    let current = header;
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
    await getClient().session.abort({ sessionID: activeId });
    cleanupChatStream(chatId);
    await safeSend(() => ctx.reply("⛔ Aborted."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to abort: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// Shell command — /shell <cmd> or !<cmd>
// ---------------------------------------------------------------------------

export async function shellCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const command = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!command) {
    await safeSend(() =>
      ctx.reply("Usage: <code>/shell command</code>\nExample: <code>/shell git status</code>\n\nOr use the <code>!</code> prefix: <code>!git status</code>", { parse_mode: "HTML" }),
    );
    return;
  }

  await executeShell(ctx, chatId, command);
}

/**
 * Execute a shell command in the current session.
 * Shared between /shell and !<cmd>.
 *
 * Uses session.shell() from the v2 SDK where agent is optional.
 * The output streams back through event hooks (message.part.delta / updated).
 */
export async function executeShell(ctx: Context, chatId: number, command: string): Promise<void> {
  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() =>
      ctx.reply("No active session. Use /attach or /new first."),
    );
    return;
  }

  try {
    await ctx.api.sendChatAction(chatId, "typing");
  } catch { /* non-fatal */ }

  await safeSend(() =>
    ctx.reply(`<code>$ ${escapeHtml(command)}</code>`, { parse_mode: "HTML" }),
  );

  try {
    // v2 SDK: agent is optional — no need to guess an agent name
    void getClient().session.shell({
      sessionID: sessionId,
      command,
    }).catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      await safeSend(() =>
        ctx.reply(`❌ Shell error: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Shell error: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /diff — Show changed files
// ---------------------------------------------------------------------------

export async function diffCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session. Use /attach or /new first."));
    return;
  }

  try {
    const result = await getClient().session.diff({
      sessionID: sessionId,
    });
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const diffs = result.data;

    if (!diffs || (diffs as any[]).length === 0) {
      await safeSend(() => ctx.reply("No file changes in this session."));
      return;
    }

    const diffList = diffs as unknown as FileDiff[];

    const statusIcon: Record<string, string> = {
      added: "🟢",
      deleted: "🔴",
      modified: "🟡",
    };

    const lines = diffList.map((d) => {
      const icon = statusIcon[d.status ?? "modified"] ?? "🟡";
      const stats = `<code>+${d.additions} -${d.deletions}</code>`;
      return `${icon} ${stats} ${escapeHtml(d.file)}`;
    });

    const totalAdd = diffList.reduce((s, d) => s + d.additions, 0);
    const totalDel = diffList.reduce((s, d) => s + d.deletions, 0);
    const summary = `\n<b>${diffList.length} file${diffList.length === 1 ? "" : "s"}</b> changed: <code>+${totalAdd} -${totalDel}</code>`;

    await safeSend(() =>
      ctx.reply(`<b>Changed Files:</b>\n\n${lines.join("\n")}${summary}`, { parse_mode: "HTML" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to get diff: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /pending — List pending permission requests
// ---------------------------------------------------------------------------

export async function pendingCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const state = getChatState(chatId);
  const pending = Array.from(state.pendingPermissions.values());

  if (pending.length === 0) {
    await safeSend(() => ctx.reply("No pending permission requests."));
    return;
  }

  const lines = pending.map((p, i) => {
    const age = Math.round((Date.now() - p.timestamp) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
    return `${i + 1}. <b>${escapeHtml(p.tool)}</b> (${ageStr})\n   ${escapeHtml(p.description.slice(0, 100))}`;
  });

  await safeSend(() =>
    ctx.reply(
      `<b>Pending Permissions (${pending.length}):</b>\n\n${lines.join("\n\n")}\n\nReply <code>YES</code>, <code>NO</code>, or <code>ALWAYS</code> to the most recent, or tap the inline buttons.`,
      { parse_mode: "HTML" },
    ),
  );
}

// ---------------------------------------------------------------------------
// /messages — Show last N messages from the session
// ---------------------------------------------------------------------------

export async function messagesCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session. Use /attach or /new first."));
    return;
  }

  const limitArg = typeof ctx.match === "string" ? parseInt(ctx.match.trim(), 10) : NaN;
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, 20) : 5;

  try {
    const result = await getClient().session.messages({
      sessionID: sessionId,
      limit,
    });
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const messages = result.data;

    if (!messages || (messages as any[]).length === 0) {
      await safeSend(() => ctx.reply("No messages in this session."));
      return;
    }

    const lines = (messages as any[]).map((m) => {
      const role = m.info.role === "user" ? "👤" : "🤖";
      const textParts = m.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!);
      const preview = textParts.join(" ").slice(0, 200);
      return `${role} <b>${escapeHtml(m.info.role)}</b>\n${escapeHtml(preview)}${preview.length >= 200 ? "…" : ""}`;
    });

    await safeSend(() =>
      ctx.reply(
        `<b>Last ${messages.length} message${messages.length === 1 ? "" : "s"}:</b>\n\n${lines.join("\n\n")}`,
        { parse_mode: "HTML" },
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to fetch messages: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /oc_undo — Revert last message + file changes
// ---------------------------------------------------------------------------

export async function ocUndoCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session."));
    return;
  }

  try {
    await getClient().session.revert({
      sessionID: sessionId,
    });
    await safeSend(() => ctx.reply("↩️ Undone. File changes reverted."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Undo failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /oc_redo — Restore undone changes
// ---------------------------------------------------------------------------

export async function ocRedoCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session."));
    return;
  }

  try {
    await getClient().session.unrevert({
      sessionID: sessionId,
    });
    await safeSend(() => ctx.reply("↪️ Redone. Changes restored."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Redo failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /oc_compact — Summarize/compact session
// ---------------------------------------------------------------------------

export async function ocCompactCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session."));
    return;
  }

  try {
    await getClient().session.summarize({
      sessionID: sessionId,
    });
    await safeSend(() => ctx.reply("📦 Session compacted."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Compact failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /oc_share — Share session and get URL
// ---------------------------------------------------------------------------

export async function ocShareCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session."));
    return;
  }

  try {
    const result = await getClient().session.share({
      sessionID: sessionId,
    });
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);

    const url = (result.data as any)?.share?.url;
    if (url) {
      await safeSend(() =>
        ctx.reply(`🔗 Session shared:\n${url}`),
      );
    } else {
      await safeSend(() => ctx.reply("✅ Session shared (no URL returned)."));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Share failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// /commands — List all available OpenCode commands
// ---------------------------------------------------------------------------

export async function commandsCommand(ctx: Context): Promise<void> {
  try {
    const result = await getClient().command.list();
    const errMsg = sdkError(result as any);
    if (errMsg) throw new Error(errMsg);
    const commands = result.data;

    if (!commands || commands.length === 0) {
      await safeSend(() => ctx.reply("No OpenCode commands available."));
      return;
    }

    const lines = commands.map((cmd) => {
      const desc = cmd.description ? ` — ${escapeHtml(cmd.description)}` : "";
      const source = cmd.source ? ` <i>[${escapeHtml(cmd.source)}]</i>` : "";
      return `• <code>/oc_${escapeHtml(cmd.name)}</code>${desc}${source}`;
    });

    await safeSend(() =>
      ctx.reply(`<b>OpenCode Commands:</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Failed to list commands: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

// ---------------------------------------------------------------------------
// Generic /oc_* handler — dispatch to session.command()
// ---------------------------------------------------------------------------

export async function ocGenericCommand(commandName: string, ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = getActiveSessionId(chatId);
  if (!sessionId) {
    await safeSend(() => ctx.reply("No active session."));
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  try {
    await getClient().session.command({
      sessionID: sessionId,
      command: commandName,
      arguments: args || "",
    });
    await safeSend(() =>
      ctx.reply(`✅ Command <code>/${escapeHtml(commandName)}</code> sent.`, { parse_mode: "HTML" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Command failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}

/**
 * Discover OpenCode commands and return them for bot menu registration.
 */
export async function discoverCommands(): Promise<OpenCodeCommand[]> {
  try {
    const result = await getClient().command.list();
    const errMsg = sdkError(result as any);
    if (errMsg) return [];
    return result.data ?? [];
  } catch {
    return [];
  }
}
