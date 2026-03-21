import type { Api, RawApi } from "grammy";
import {
  getAllChatIds,
  getChatState,
  type ChatState,
} from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { markdownToTelegramHtml, stripHtml } from "../utils/format.js";
import { chunkMessage } from "../utils/chunk.js";
import { createThrottle, type Throttle } from "../utils/throttle.js";
import { safeSend } from "../utils/safeSend.js";
import { startTyping } from "../utils/typing.js";

export interface HookContext {
  api: Api<RawApi>;
  /** Minimum milliseconds between successive editMessageText calls per chat */
  editIntervalMs: number;
}

interface MessagePart {
  type: string;
  text?: string;
  state?: string;
}

interface MessageEvent {
  type: "message.updated";
  properties: {
    sessionID: string;
    messageID: string;
    parts: MessagePart[];
  };
}

/** Rate-limiting throttle instances keyed by chatId */
const chatThrottles = new Map<number, Throttle>();

function getOrCreateThrottle(chatId: number, intervalMs: number): Throttle {
  const existing = chatThrottles.get(chatId);
  if (existing !== undefined) return existing;
  const t = createThrottle({ intervalMs });
  chatThrottles.set(chatId, t);
  return t;
}

export function handleMessageUpdated(
  event: MessageEvent,
  ctx: HookContext,
): void {
  const { sessionID, parts } = event.properties;
  const { api, editIntervalMs } = ctx;

  const textParts = parts.filter((p) => p.type === "text");
  if (textParts.length === 0) return;

  const rawText = textParts.map((p) => p.text ?? "").join("");
  if (!rawText.trim()) return;

  const isFinal =
    textParts.some((p) => p.state === "complete") &&
    textParts.every((p) => !p.state || p.state === "complete");

  const html = markdownToTelegramHtml(rawText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    const chatState = getChatState(chatId);
    if (chatState.stream.state === "FINAL") continue;

    void processStreamForChat(
      chatId,
      chatState,
      html,
      rawText,
      isFinal,
      api,
      editIntervalMs,
    );
  }
}

/** Edit a Telegram message with HTML, falling back to plain text on parse errors. */
async function editWithFallback(
  api: Api<RawApi>,
  chatId: number,
  messageId: number,
  html: string,
): Promise<void> {
  const result = await safeSend(() =>
    api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" }),
  );
  if (!result.ok && result.reason === "parse error") {
    await safeSend(() =>
      api.editMessageText(chatId, messageId, stripHtml(html)),
    );
  }
}

async function processStreamForChat(
  chatId: number,
  chatState: ChatState,
  html: string,
  rawText: string,
  isFinal: boolean,
  api: Api<RawApi>,
  editIntervalMs: number,
): Promise<void> {
  // ── Initial send ──────────────────────────────────────────────────────────
  if (
    chatState.stream.state === "IDLE" ||
    chatState.stream.state === "PENDING_SEND" ||
    chatState.stream.state === "FINAL"
  ) {
    // Lock immediately to prevent duplicate sends on concurrent events
    chatState.stream.state = "PENDING_SEND";
    if (!chatState.typingStop) {
      chatState.typingStop = startTyping(api, chatId);
    }

    const chunks = chunkMessage(html);
    if (chunks.length === 0) return;

    const firstResult = await safeSend(() =>
      api.sendMessage(chatId, chunks[0], { parse_mode: "HTML" }),
    );

    if (!firstResult.ok) {
      chatState.typingStop?.();
      chatState.typingStop = null;
      chatState.stream.state = "IDLE";
      return;
    }

    chatState.stream.messageId = firstResult.messageId ?? null;
    chatState.stream.state = "SENT";
    chatState.stream.lastSentText = rawText;

    // Send overflow chunks as follow-up messages
    for (let i = 1; i < chunks.length; i++) {
      const r = await safeSend(() =>
        api.sendMessage(chatId, chunks[i], { parse_mode: "HTML" }),
      );
      if (r.ok && r.messageId !== undefined) {
        chatState.stream.chunks.push(r.messageId);
      }
    }

    if (isFinal) {
      await finalizeStream(chatId, chatState);
    }
    return;
  }

  // ── Streaming edits ───────────────────────────────────────────────────────
  if (
    chatState.stream.state === "SENT" ||
    chatState.stream.state === "EDITING"
  ) {
    if (rawText === chatState.stream.lastSentText && !isFinal) return;

    chatState.stream.state = "EDITING";

    const capturedGeneration = chatState.stream.streamGeneration;
    const doEdit = async (): Promise<void> => {
      // Guard: bail if the stream was reset between scheduling and execution
      if (
        chatState.stream.streamGeneration !== capturedGeneration ||
        (chatState.stream.state !== "EDITING" &&
         chatState.stream.state !== "SENT")
      ) {
        return;
      }

      const msgId = chatState.stream.messageId;
      if (msgId === null) return;

      const editChunks = chunkMessage(html);
      if (editChunks.length === 0) return;

      const editResult = await safeSend(() =>
        api.editMessageText(chatId, msgId, editChunks[0], {
          parse_mode: "HTML",
        }),
      );

      if (!editResult.ok) {
        if (editResult.reason === "parse error") {
          await safeSend(() =>
            api.editMessageText(chatId, msgId, stripHtml(editChunks[0])),
          );
        } else if (editResult.reason === "bot blocked") {
          chatState.typingStop?.();
          chatState.typingStop = null;
          return;
        }
      }

      chatState.stream.lastSentText = rawText;

      // Sync overflow chunks — edit existing or send new ones
      for (let i = 1; i < editChunks.length; i++) {
        const existingId = chatState.stream.chunks[i - 1];
        if (existingId !== undefined) {
          await editWithFallback(api, chatId, existingId, editChunks[i]);
        } else {
          const r = await safeSend(() =>
            api.sendMessage(chatId, editChunks[i], { parse_mode: "HTML" }),
          );
          if (r.ok && r.messageId !== undefined) {
            chatState.stream.chunks.push(r.messageId);
          }
        }
      }

      // Delete stale overflow messages if text shrank
      const excessStart = editChunks.length - 1;
      if (excessStart < chatState.stream.chunks.length) {
        for (let j = chatState.stream.chunks.length - 1; j >= excessStart; j--) {
          void safeSend(() => api.deleteMessage(chatId, chatState.stream.chunks[j]));
        }
        chatState.stream.chunks.length = Math.max(excessStart, 0);
      }
    };

    if (isFinal) {
      // Cancel any pending throttled update and perform one final synchronous edit
      const pending = chatThrottles.get(chatId);
      if (pending) {
        pending.cancel();
        chatThrottles.delete(chatId);
      }
      if (rawText !== chatState.stream.lastSentText) {
        await doEdit();
      }
      await finalizeStream(chatId, chatState);
    } else {
      const throttle = getOrCreateThrottle(chatId, editIntervalMs);
      void throttle(doEdit);
    }
  }
}

async function finalizeStream(
  chatId: number,
  chatState: ChatState,
): Promise<void> {
  // Stop typing indicator
  chatState.typingStop?.();
  chatState.typingStop = null;

  // Cancel and discard throttle
  const throttle = chatThrottles.get(chatId);
  if (throttle) {
    throttle.cancel();
    chatThrottles.delete(chatId);
  }

  // Mark stream as finalized — stays FINAL until a new stream starts
  chatState.stream.state = "FINAL";
}
