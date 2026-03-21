import type { Api, RawApi } from "grammy";
import { getAllChatIds, getChatState, cleanupChatStream } from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { escapeHtml } from "../utils/format.js";
import { safeSend } from "../utils/safeSend.js";

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
        `🚀 <b>Session started</b>\n<code>${displayName}</code>`,
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

  for (const chatId of attachedChatIds(sessionID)) {
    // Clean up stream state + typing indicator
    cleanupChatStream(chatId);

    void safeSend(() =>
      api.sendMessage(chatId, "💤 <i>Session idle</i>", {
        parse_mode: "HTML",
      }),
    );
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
    // Clean up stream state + typing indicator
    cleanupChatStream(chatId);

    void safeSend(() =>
      api.sendMessage(
        chatId,
        `⚠️ <b>Error:</b> <code>${escapeHtml(error)}</code>`,
        { parse_mode: "HTML" },
      ),
    );
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

  // Skip empty or whitespace-only status strings to avoid noise
  if (!status.trim()) return;

  for (const chatId of attachedChatIds(sessionID)) {
    void safeSend(() =>
      api.sendMessage(chatId, `ℹ️ <i>${escapeHtml(status)}</i>`, {
        parse_mode: "HTML",
      }),
    );
  }
}
