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

interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

interface MessageInfo {
  id: string;
  role: string;
  createdAt?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface SessionData {
  id: string;
  title?: string;
  share?: { url: string };
}

interface AssistantMessage {
  parts?: MessagePart[];
}

interface OpenCodeCommand {
  name: string;
  description?: string;
  source?: string;
}

interface OpenCodeClient {
  session: {
    list(): Promise<{ data: SessionSummary[] }>;
    create(params: { body: { title: string } }): Promise<{ data: { id: string } }>;
    abort(params: { path: { id: string } }): Promise<boolean>;
    shell(params: { path: { id: string }; body: { agent: string; command: string } }): Promise<{ data: AssistantMessage }>;
    diff(params: { path: { id: string }; query?: { messageID?: string } }): Promise<{ data: FileDiff[] }>;
    share(params: { path: { id: string } }): Promise<{ data: SessionData }>;
    unshare(params: { path: { id: string } }): Promise<{ data: SessionData }>;
    revert(params: { path: { id: string }; body?: { messageID: string } }): Promise<{ data: SessionData }>;
    unrevert(params: { path: { id: string } }): Promise<{ data: SessionData }>;
    summarize(params: { path: { id: string }; body?: { providerID: string; modelID: string } }): Promise<{ data: boolean }>;
    messages(params: { path: { id: string }; query?: { limit?: number } }): Promise<{ data: Array<{ info: MessageInfo; parts: MessagePart[] }> }>;
    command(params: { path: { id: string }; body: { command: string; arguments: string } }): Promise<{ data: unknown }>;
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
  command: {
    list(): Promise<{ data: OpenCodeCommand[] }>;
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

    // Validate provider exists, but allow any model ID (favorites may not be in models list)
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
    const { data } = await getClient().config.providers();
    const providers = data?.providers ?? [];

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
    const sorted = [...providers].sort((a, b) =>
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
 * Execute a shell command in the current session and send the result.
 * Shared between /shell and !<cmd>.
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

  try {
    const { data } = await getClient().session.shell({
      path: { id: sessionId },
      body: { agent: "", command },
    });

    const parts = data?.parts ?? [];
    const textParts = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!);

    const output = textParts.join("\n").trim();

    if (!output) {
      await safeSend(() =>
        ctx.reply(`<code>$ ${escapeHtml(command)}</code>\n<i>(no output)</i>`, { parse_mode: "HTML" }),
      );
      return;
    }

    // Chunk output if needed (4000 char limit for safety)
    const header = `<code>$ ${escapeHtml(command)}</code>\n`;
    const MAX_LEN = 4000 - header.length;

    if (output.length <= MAX_LEN) {
      await safeSend(() =>
        ctx.reply(`${header}<pre>${escapeHtml(output)}</pre>`, { parse_mode: "HTML" }),
      );
    } else {
      // Send header first, then chunks
      await safeSend(() =>
        ctx.reply(header, { parse_mode: "HTML" }),
      );

      let remaining = output;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, 4000);
        remaining = remaining.slice(4000);
        await safeSend(() =>
          ctx.reply(`<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: "HTML" }),
        );
      }
    }
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
    const { data: diffs } = await getClient().session.diff({
      path: { id: sessionId },
    });

    if (!diffs || diffs.length === 0) {
      await safeSend(() => ctx.reply("No file changes in this session."));
      return;
    }

    const statusIcon: Record<string, string> = {
      added: "🟢",
      deleted: "🔴",
      modified: "🟡",
    };

    const lines = diffs.map((d) => {
      const icon = statusIcon[d.status ?? "modified"] ?? "🟡";
      const stats = `<code>+${d.additions} -${d.deletions}</code>`;
      return `${icon} ${stats} ${escapeHtml(d.file)}`;
    });

    const totalAdd = diffs.reduce((s, d) => s + d.additions, 0);
    const totalDel = diffs.reduce((s, d) => s + d.deletions, 0);
    const summary = `\n<b>${diffs.length} file${diffs.length === 1 ? "" : "s"}</b> changed: <code>+${totalAdd} -${totalDel}</code>`;

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
    const { data: messages } = await getClient().session.messages({
      path: { id: sessionId },
      query: { limit },
    });

    if (!messages || messages.length === 0) {
      await safeSend(() => ctx.reply("No messages in this session."));
      return;
    }

    const lines = messages.map((m) => {
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
      path: { id: sessionId },
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
      path: { id: sessionId },
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
      path: { id: sessionId },
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
    const { data } = await getClient().session.share({
      path: { id: sessionId },
    });

    const url = data?.share?.url;
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
    const { data: commands } = await getClient().command.list();

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
      path: { id: sessionId },
      body: { command: commandName, arguments: args || "" },
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
    const { data } = await getClient().command.list();
    return data ?? [];
  } catch {
    return [];
  }
}
