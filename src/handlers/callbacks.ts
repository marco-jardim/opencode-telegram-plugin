import type { Context } from "grammy";
import { resolveCallback, getChatState } from "../state/store.js";
import { attachSession } from "../state/mode.js";
import { safeSend } from "../utils/safeSend.js";
import { escapeHtml } from "../utils/format.js";

// ---------------------------------------------------------------------------
// Client interface — only the methods used in this file
// ---------------------------------------------------------------------------

interface OpenCodeClient {
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
 * Safely edits the text of the message that contained the tapped button.
 * Swallows errors (the message may already be edited or deleted).
 */
async function safeEditText(ctx: Context, text: string): Promise<void> {
  await safeSend(() =>
    ctx.editMessageText(text, { parse_mode: "HTML" }),
  );
}

/**
 * Returns the original text of the callback message, or an empty string.
 */
function originalMessageText(ctx: Context): string {
  return ctx.callbackQuery?.message?.text ?? "";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles all inline-button callback queries.
 *
 * We always call `ctx.answerCallbackQuery()` — even on the error paths —
 * so Telegram dismisses the loading spinner on the client side.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;

  // Malformed query — nothing we can do except dismiss the spinner
  if (!callbackData) {
    await safeSend(() =>
      ctx.answerCallbackQuery({ text: "Invalid callback." }),
    );
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await safeSend(() =>
      ctx.answerCallbackQuery({ text: "Unknown chat." }),
    );
    return;
  }

  // Resolve the opaque key back to its action + data payload
  const entry = resolveCallback(callbackData);
  if (!entry) {
    await safeSend(() =>
      ctx.answerCallbackQuery({
        text: "⏰ This button has expired. Please repeat the command.",
        show_alert: true,
      }),
    );
    return;
  }

  try {
    switch (entry.action) {
      // ----------------------------------------------------------------
      // Permission approval (once)
      // ----------------------------------------------------------------
      case "perm_approve": {
        const { sessionId, permissionId } = entry.data;
        if (!sessionId || !permissionId) {
          await safeSend(() =>
            ctx.answerCallbackQuery({ text: "Invalid callback data." }),
          );
          return;
        }

        await getClient().postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          body: { response: "once" },
        });

        getChatState(chatId).pendingPermissions.delete(permissionId);
        await safeSend(() => ctx.answerCallbackQuery({ text: "✅ Approved" }));
        await safeEditText(
          ctx,
          `${escapeHtml(originalMessageText(ctx))}\n\n✅ <b>Approved</b>`,
        );
        break;
      }

      // ----------------------------------------------------------------
      // Permission approval (always) — permanently whitelist
      // ----------------------------------------------------------------
      case "perm_always": {
        const { sessionId, permissionId } = entry.data;
        if (!sessionId || !permissionId) {
          await safeSend(() =>
            ctx.answerCallbackQuery({ text: "Invalid callback data." }),
          );
          return;
        }

        await getClient().postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          body: { response: "always" },
        });

        getChatState(chatId).pendingPermissions.delete(permissionId);
        await safeSend(() => ctx.answerCallbackQuery({ text: "✅ Always Allowed" }));
        await safeEditText(
          ctx,
          `${escapeHtml(originalMessageText(ctx))}\n\n✅ <b>Always Allowed</b>`,
        );
        break;
      }

      // ----------------------------------------------------------------
      // Permission denial
      // ----------------------------------------------------------------
      case "perm_deny": {
        const { sessionId, permissionId } = entry.data;
        if (!sessionId || !permissionId) {
          await safeSend(() =>
            ctx.answerCallbackQuery({ text: "Invalid callback data." }),
          );
          return;
        }

        try {
          await getClient().postSessionIdPermissionsPermissionId({
            path: { id: sessionId, permissionID: permissionId },
            body: { response: "reject" },
          });
        } catch {
          // SDK may not support explicit deny — fall through silently
        }

        getChatState(chatId).pendingPermissions.delete(permissionId);
        await safeSend(() => ctx.answerCallbackQuery({ text: "❌ Denied" }));
        await safeEditText(
          ctx,
          `${escapeHtml(originalMessageText(ctx))}\n\n❌ <b>Denied</b>`,
        );
        break;
      }

      // ----------------------------------------------------------------
      // Session attachment (from /attach or /switch picker)
      // ----------------------------------------------------------------
      case "attach_session": {
        const { sessionId } = entry.data;
        if (!sessionId) {
          await safeSend(() =>
            ctx.answerCallbackQuery({ text: "Invalid session ID." }),
          );
          return;
        }

        attachSession(chatId, sessionId);

        await safeSend(() =>
          ctx.answerCallbackQuery({ text: "✅ Attached!" }),
        );
        await safeEditText(
          ctx,
          `✅ Attached to session:\n<code>${escapeHtml(sessionId)}</code>`,
        );
        break;
      }

      // ----------------------------------------------------------------
      // Model selection — reserved for future use
      // ----------------------------------------------------------------
      case "model_select": {
        const { modelId } = entry.data;
        await safeSend(() =>
          ctx.answerCallbackQuery({
            text: modelId ? `Selected: ${modelId}` : "Model selection coming soon.",
          }),
        );
        break;
      }

      // ----------------------------------------------------------------
      // Unknown action
      // ----------------------------------------------------------------
      default: {
        await safeSend(() =>
          ctx.answerCallbackQuery({ text: "Unknown action." }),
        );
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort: surface the error to the user via the callback answer
    await safeSend(() =>
      ctx.answerCallbackQuery({
        text: `❌ ${msg.slice(0, 190)}`,
        show_alert: true,
      }),
    );
  }
}
