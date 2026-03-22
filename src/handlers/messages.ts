import type { Context } from "grammy";
import { getActiveSessionId, attachSession } from "../state/mode.js";
import { getChatState } from "../state/store.js";
import { safeSend } from "../utils/safeSend.js";
import { escapeHtml } from "../utils/format.js";
import { executeShell } from "./commands.js";

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
      body: {
        parts: [{ type: "text"; text: string }];
        model?: { providerID: string; modelID: string };
        effort?: string;
      };
    }): Promise<{ data: { info: unknown; parts: unknown[] } }>;
  };
  postSessionIdPermissionsPermissionId(params: {
    path: { id: string; permissionID: string };
    body: { response: "once" | "always" | "reject" };
  }): Promise<unknown>;
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
// Permission text-reply helper
// ---------------------------------------------------------------------------

type PermissionReply = "once" | "always" | "reject";

function parsePermissionReply(text: string): PermissionReply | null {
  const lower = text.trim().toLowerCase();
  if (lower === "yes" || lower === "y" || lower === "approve") return "once";
  if (lower === "always" || lower === "yes always") return "always";
  if (lower === "no" || lower === "n" || lower === "deny" || lower === "reject") return "reject";
  return null;
}

const REPLY_LABELS: Record<PermissionReply, string> = {
  once: "✅ Approved",
  always: "✅ Always Allowed",
  reject: "❌ Denied",
};

/**
 * Try to resolve a text-based permission reply.
 * Returns true if the message was handled as a permission reply.
 */
async function tryPermissionReply(ctx: Context, chatId: number, text: string): Promise<boolean> {
  const reply = parsePermissionReply(text);
  if (!reply) return false;

  const state = getChatState(chatId);
  if (state.pendingPermissions.size === 0) return false;

  // If replying to a specific permission message, match by telegramMessageId
  const replyToId = ctx.message?.reply_to_message?.message_id;
  let targetPerm: { permissionId: string; sessionId: string } | null = null;

  if (replyToId) {
    for (const perm of state.pendingPermissions.values()) {
      if (perm.telegramMessageId === replyToId) {
        targetPerm = { permissionId: perm.permissionId, sessionId: perm.sessionId };
        break;
      }
    }
  }

  // Fallback: apply to most recent pending permission
  if (!targetPerm) {
    let latest: { permissionId: string; sessionId: string; timestamp: number } | null = null;
    for (const perm of state.pendingPermissions.values()) {
      if (!latest || perm.timestamp > latest.timestamp) {
        latest = { permissionId: perm.permissionId, sessionId: perm.sessionId, timestamp: perm.timestamp };
      }
    }
    if (latest) {
      targetPerm = { permissionId: latest.permissionId, sessionId: latest.sessionId };
    }
  }

  if (!targetPerm) return false;

  try {
    await getClient().postSessionIdPermissionsPermissionId({
      path: { id: targetPerm.sessionId, permissionID: targetPerm.permissionId },
      body: { response: reply },
    });

    state.pendingPermissions.delete(targetPerm.permissionId);
    await safeSend(() =>
      ctx.reply(REPLY_LABELS[reply], { parse_mode: "HTML" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(() =>
      ctx.reply(`❌ Permission reply failed: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles every plain-text message sent to the bot.
 *
 * Flow:
 *  1. Check for !<cmd> shell prefix.
 *  2. Check for permission text replies (YES/NO/ALWAYS).
 *  3. Resolve (or auto-attach to) an active session.
 *  4. Fire the prompt against the OpenCode SDK.
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
  // 1. Shell prefix: !<command>
  // ------------------------------------------------------------------
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    if (command) {
      await executeShell(ctx, chatId, command);
      return;
    }
  }

  // ------------------------------------------------------------------
  // 2. Text-based permission replies (YES/NO/ALWAYS)
  // ------------------------------------------------------------------
  const handled = await tryPermissionReply(ctx, chatId, text);
  if (handled) return;

  // ------------------------------------------------------------------
  // 3. Resolve active session
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
  // 4. Show typing indicator (best-effort)
  // ------------------------------------------------------------------
  try {
    await ctx.api.sendChatAction(chatId, "typing");
  } catch {
    // Non-fatal — the message will still be sent
  }

  // ------------------------------------------------------------------
  // 5. Fire the prompt — response streams via event hooks, not here
  // ------------------------------------------------------------------
  const capturedSessionId = sessionId; // capture before any async gap

  // Build prompt body with optional model/effort overrides
  const chatState = getChatState(chatId);
  const promptBody: {
    parts: [{ type: "text"; text: string }];
    model?: { providerID: string; modelID: string };
    effort?: string;
  } = { parts: [{ type: "text", text }] };

  if (chatState.selectedModel) {
    promptBody.model = {
      providerID: chatState.selectedModel.providerID,
      modelID: chatState.selectedModel.modelID,
    };
  }
  if (chatState.effort !== "high") {
    promptBody.effort = chatState.effort;
  }

  try {
    void getClient()
      .session.prompt({
        path: { id: capturedSessionId },
        body: promptBody,
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
