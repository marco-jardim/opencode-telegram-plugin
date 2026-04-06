import type { Context } from "grammy";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { getActiveSessionId, attachSession } from "../state/mode.js";
import { getChatState, type CavemanLevel } from "../state/store.js";
import { safeSend } from "../utils/safeSend.js";
import { escapeHtml } from "../utils/format.js";
import { executeShell } from "./commands.js";

// ---------------------------------------------------------------------------
// Caveman prompts — match commands.ts CAVEMAN_PROMPTS
// Based on JuliusBrussee/caveman SKILL.md
// ---------------------------------------------------------------------------

const CAVEMAN_PROMPTS: Record<CavemanLevel, string> = {
  off: "",
  lite: `CAVEMAN MODE (lite):
- Drop filler: just, really, basically, actually, simply
- Drop pleasantries: sure, certainly, happy to help
- No hedging: skip "it might be worth considering"
- Short synonyms: big not extensive, fix not "implement a solution"
- Keep grammar. Technical terms exact. Code unchanged.

`,
  full: `CAVEMAN MODE — follow these rules for this response:

CORE: Drop articles (a, an, the). Drop filler. Drop pleasantries. Keep all technical substance.

GRAMMAR:
- Drop articles (a, an, the)
- Drop filler: just, really, basically, actually, simply
- Drop pleasantries: sure, certainly, of course, happy to
- Short synonyms: big not extensive, fix not "implement a solution for"
- No hedging: skip "it might be worth considering"
- Fragments fine. No need full sentence.
- Technical terms stay exact. "Polymorphism" stays "polymorphism"
- Code blocks unchanged. Caveman speak around code, not in code
- Error messages quoted exact

PATTERN: [thing] [action] [reason]. [next step].
NOT: "Sure! I'd be happy to help. The issue is likely caused by..."
YES: "Bug in auth middleware. Token expiry check use < not <=. Fix:"

BOUNDARIES:
- Code: write normal. Caveman English only.
- Technical terms: exact.
- Error messages: quoted exact.

`,
  ultra: `CAVEMAN MODE (ultra) — MAXIMUM COMPRESSION:

- Telegraphic style only. Minimum words possible.
- Use symbols: → = ≠
- Abbreviate: obj, ref, impl, config, req, resp
- Drop articles, filler, pleasantries, hedging
- Fragments. No full sentences needed.
- Technical terms exact. Code unchanged.
- Pattern: thing → action → reason. next step.

`,
};

// ---------------------------------------------------------------------------
// Client — v2 SDK (flat parameter style)
// ---------------------------------------------------------------------------

let _client: OpencodeClient | null = null;

export function setClient(client: OpencodeClient): void {
  _client = client;
}

function getClient(): OpencodeClient {
  if (!_client) throw new Error("OpenCode client not initialized");
  return _client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable error string from v2 SDK responses.
 * Handles: string, object with message/code, array of validation errors.
 */
function extractSdkError(err: unknown): string {
  if (typeof err === "string") return err;
  if (Array.isArray(err)) {
    return err
      .map((e: any) => {
        const path = e.path ? e.path.join(".") : "";
        const msg = e.message ?? e.code ?? JSON.stringify(e);
        return path ? `${path}: ${msg}` : msg;
      })
      .join("; ");
  }
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.message) return String(e.message);
    if (e.code) return String(e.code);
    return JSON.stringify(err);
  }
  return String(err);
}

/**
 * Attempt to auto-attach to the most recently created session.
 * Returns the resolved session ID on success, or null if unavailable.
 */
async function tryAutoAttach(chatId: number): Promise<string | null> {
  try {
    const result = await getClient().session.list();
    if (result.error || !result.data || result.data.length === 0) return null;

    const latest = [...result.data].sort(
      (a, b) => ((b as any).time?.updated ?? (b as any).time?.created ?? 0) - ((a as any).time?.updated ?? (a as any).time?.created ?? 0),
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
    const result = await getClient().permission.respond({
      sessionID: targetPerm.sessionId,
      permissionID: targetPerm.permissionId,
      response: reply,
    });

    const sdkErr = (result as any)?.error;
    if (sdkErr) {
      const errMsg = typeof sdkErr === "string" ? sdkErr
        : sdkErr?.message ?? sdkErr?.code ?? "Unknown error";
      await safeSend(() =>
        ctx.reply(`❌ Permission reply failed: ${escapeHtml(String(errMsg))}`, { parse_mode: "HTML" }),
      );
      return true; // consumed the message even if reply failed
    }

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
      ctx.reply("No active session. Use /attach or /new."),
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

  // Caveman: prepend instruction to user text only — no system parts, TUI stays clean
  const cavemanPrefix = chatState.caveman !== "off" ? CAVEMAN_PROMPTS[chatState.caveman] + "\n\n" : "";

  try {
    // Fire-and-forget — response streams via event hooks, not here.
    // Check for SDK-level errors (ThrowOnError=false returns { error }).
    void getClient()
      .session.prompt({
        sessionID: capturedSessionId,
        parts: [{ type: "text" as const, text: cavemanPrefix + text }],
        ...(chatState.selectedModel ? {
          model: {
            providerID: chatState.selectedModel.providerID,
            modelID: chatState.selectedModel.modelID,
          },
        } : {}),
      })
      .then(async (result: any) => {
        if (result?.error) {
          const errStr = extractSdkError(result.error);

          if (errStr.includes("ProviderModelNotFoundError") || errStr.includes("provider model not found")) {
            await safeSend(() =>
              ctx.reply(
                `⚠️ Model error: ${escapeHtml(errStr)}\n\n` +
                `Check that the model is available. Use <code>/model provider/id</code> to change.`,
                { parse_mode: "HTML" },
              ),
            );
            return;
          }

          await safeSend(() =>
            ctx.reply(`❌ Error sending prompt: ${escapeHtml(errStr)}`, { parse_mode: "HTML" }),
          );
        }
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("ProviderModelNotFoundError") || msg.includes("provider model not found")) {
          await safeSend(() =>
            ctx.reply(
              `⚠️ Model error: ${escapeHtml(msg)}\n\n` +
              `Check that the model is available. Use <code>/model provider/id</code> to change.`,
              { parse_mode: "HTML" },
            ),
          );
          return;
        }

        await safeSend(() =>
          ctx.reply(`❌ Error sending prompt: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
        );
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("ProviderModelNotFoundError") || msg.includes("provider model not found")) {
      await safeSend(() =>
        ctx.reply(
          `⚠️ Model error: ${escapeHtml(msg)}\n\n` +
          `Check that the model is available. Use <code>/model provider/id</code> to change.`,
          { parse_mode: "HTML" },
        ),
      );
      return;
    }

    await safeSend(() =>
      ctx.reply(`❌ Error sending prompt: ${escapeHtml(msg)}`, { parse_mode: "HTML" }),
    );
  }
}
