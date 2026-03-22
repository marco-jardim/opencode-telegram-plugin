import type { Context } from "grammy";
import { getActiveSessionId, attachSession } from "../state/mode.js";
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
    prompt(params: {
      path: { id: string };
      body: { parts: [{ type: "text"; text: string }] };
    }): Promise<{ data: { info: unknown; parts: unknown[] } }>;
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

/**
 * Attempt to auto-attach to the most recently created session.
 * Returns the resolved session ID on success, or null if unavailable.
 */
async function tryAutoAttach(chatId: number): Promise<string | null> {
  try {
    const { data: sessions } = await getClient().session.list();
    if (sessions.length === 0) return null;

    const latest = [...sessions].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0]!;

    attachSession(chatId, latest.id);
    return latest.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles every plain-text message sent to the bot.
 *
 * Flow:
 *  1. Resolve (or auto-attach to) an active session.
 *  2. Fire the prompt against the OpenCode SDK — without awaiting the full
 *     response, because the streaming reply arrives through event hooks
 *     (message.updated) and is handled by a separate event listener.
 *  3. Propagate any errors back to the user.
 */
export async function handleTextMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text;
  if (!text) return;

  // Ignore messages that look like unrecognized commands (e.g. /models, /foo)
  // — these should not be forwarded as prompts to OpenCode
  if (text.startsWith("/")) return;

  // ------------------------------------------------------------------
  // 1. Resolve active session
  // ------------------------------------------------------------------
  let sessionId = getActiveSessionId(chatId);

  if (!sessionId) {
    const autoAttach = process.env["TELEGRAM_AUTO_ATTACH"] !== "false";
    if (autoAttach) {
      sessionId = await tryAutoAttach(chatId);
    }
  }

  if (!sessionId) {
    await safeSend(() =>
      ctx.reply(
        "No active session.\n" +
          "Use /attach to connect to an existing session or /new to create one.",
      ),
    );
    return;
  }

  // ------------------------------------------------------------------
  // 2. Show typing indicator (best-effort)
  // ------------------------------------------------------------------
  try {
    await ctx.api.sendChatAction(chatId, "typing");
  } catch {
    // Non-fatal — the message will still be sent
  }

  // ------------------------------------------------------------------
  // 3. Fire the prompt — response streams via event hooks, not here
  // ------------------------------------------------------------------
  const capturedSessionId = sessionId; // capture before any async gap

  try {
    void getClient()
      .session.prompt({
        path: { id: capturedSessionId },
        body: { parts: [{ type: "text", text }] },
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await safeSend(() =>
          ctx.reply(`❌ Error sending prompt: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
        );
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Error sending prompt: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}
