import type { Api, RawApi } from "grammy";
import { getAllChatIds, getChatState, cleanupChatStream } from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { escapeHtml } from "../utils/format.js";
import { safeSend } from "../utils/safeSend.js";
import { cleanupStream, gracefulFinalizeStream } from "./message.js";

export interface HookContext {
  api: Api<RawApi>;
  editIntervalMs: number;
}

/** Returns all chat IDs whose active session matches `sessionID` (any mode). */
function matchingChatIds(sessionID: string): number[] {
  return getAllChatIds().filter(
    (chatId) => getActiveSessionId(chatId) === sessionID,
  );
}

/** Returns only "attached"-mode chat IDs whose active session matches `sessionID`. */
function attachedChatIds(sessionID: string): number[] {
  return getAllChatIds().filter((chatId) => {
    const cs = getChatState(chatId);
    return cs.mode === "attached" && getActiveSessionId(chatId) === sessionID;
  });
}

/** Gracefully finalize stream, clean up store, then send idle message. */
async function finalizeAndCleanup(chatId: number, api: Api<RawApi>): Promise<void> {
  await gracefulFinalizeStream(chatId);
  cleanupChatStream(chatId);
  await safeSend(() =>
    api.sendMessage(chatId, "⏸ <i>idle</i>", {
      parse_mode: "HTML",
    }),
  );
}

export function handleSessionCreated(
  event: {
    type: "session.created";
    properties: { sessionID: string; title?: string };
  },
  ctx: HookContext,
): void {
  const { sessionID, title } = event.properties;
  const { api } = ctx;

  const displayName = title ? escapeHtml(title) : escapeHtml(sessionID);

  for (const chatId of attachedChatIds(sessionID)) {
    void safeSend(() =>
      api.sendMessage(
        chatId,
        `🚀 ${displayName}`,
        { parse_mode: "HTML" },
      ),
    );
  }
}

export function handleSessionIdle(
  event: {
    type: "session.idle";
    properties: { sessionID: string };
  },
  ctx: HookContext,
): void {
  const { sessionID } = event.properties;
  const { api } = ctx;

  for (const chatId of matchingChatIds(sessionID)) {
    // Gracefully finalize any active stream (does final edit with latest text)
    // then clean up. finalizeAndCleanup is async — fire-and-forget.
    void finalizeAndCleanup(chatId, api);
  }
}

export function handleSessionError(
  event: {
    type: "session.error";
    properties: { sessionID: string; error: string };
  },
  ctx: HookContext,
): void {
  const { sessionID, error } = event.properties;
  const { api } = ctx;

  // Errors go to all matching chats regardless of mode
  for (const chatId of matchingChatIds(sessionID)) {
    // Gracefully finalize stream before reporting error
    void (async () => {
      await gracefulFinalizeStream(chatId);
      cleanupChatStream(chatId);
      await safeSend(() =>
        api.sendMessage(
          chatId,
          `⚠️ <code>${escapeHtml(error)}</code>`,
          { parse_mode: "HTML" },
        ),
      );
    })();
  }
}

export function handleSessionStatus(
  event: {
    type: "session.status";
    properties: { sessionID: string; status: string };
  },
  ctx: HookContext,
): void {
  const { sessionID, status } = event.properties;
  const { api } = ctx;

  // Skip empty, whitespace-only, or missing status strings to avoid noise
  if (typeof status !== "string" || !status.trim()) return;

  // Only surface meaningful status changes — skip verbose intermediate states
  const notable = ["thinking", "planning", "waiting", "error", "done", "complete", "idle"];
  if (!notable.some((s) => status.toLowerCase().includes(s))) return;

  for (const chatId of attachedChatIds(sessionID)) {
    void safeSend(() =>
      api.sendMessage(chatId, `ℹ️ <i>${escapeHtml(status)}</i>`, {
        parse_mode: "HTML",
      }),
    );
  }
}
