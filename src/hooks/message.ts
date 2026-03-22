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

// ---------------------------------------------------------------------------
// Event shapes (matching actual OpenCode SDK events)
// ---------------------------------------------------------------------------

export interface PartUpdatedEvent {
  type: "message.part.updated";
  properties: {
    part: {
      id: string;
      sessionID: string;
      messageID: string;
      type: string;
      text?: string;
      state?: string;
    };
  };
}

export interface PartDeltaEvent {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

// ---------------------------------------------------------------------------
// Per-chat accumulated text (built from deltas between part.updated events)
// Key: chatId → { partID → accumulated text }
// ---------------------------------------------------------------------------

const partTextAccumulator = new Map<string, string>();

function getAccumulatedText(partID: string): string {
  return partTextAccumulator.get(partID) ?? "";
}

function appendDelta(partID: string, delta: string): string {
  const current = partTextAccumulator.get(partID) ?? "";
  const updated = current + delta;
  partTextAccumulator.set(partID, updated);
  return updated;
}

function clearAccumulated(partID: string): void {
  partTextAccumulator.delete(partID);
}

// ---------------------------------------------------------------------------
// Throttle instances keyed by chatId
// ---------------------------------------------------------------------------

const chatThrottles = new Map<number, Throttle>();

function getOrCreateThrottle(chatId: number, intervalMs: number): Throttle {
  const existing = chatThrottles.get(chatId);
  if (existing !== undefined) return existing;
  const t = createThrottle({ intervalMs });
  chatThrottles.set(chatId, t);
  return t;
}

// ---------------------------------------------------------------------------
// Handle message.part.delta — incremental streaming text
// ---------------------------------------------------------------------------

export function handlePartDelta(
  event: PartDeltaEvent,
  ctx: HookContext,
): void {
  const { sessionID, partID, field, delta } = event.properties;
  if (field !== "text") return;

  const { api, editIntervalMs } = ctx;
  const fullText = appendDelta(partID, delta);

  if (!fullText.trim()) return;

  const html = markdownToTelegramHtml(fullText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    const chatState = getChatState(chatId);
    void processStreamForChat(
      chatId,
      chatState,
      html,
      fullText,
      false, // delta is never final
      api,
      editIntervalMs,
    );
  }
}

// ---------------------------------------------------------------------------
// Handle message.part.updated — full part snapshot (may be final)
// ---------------------------------------------------------------------------

export function handlePartUpdated(
  event: PartUpdatedEvent,
  ctx: HookContext,
): void {
  const { part } = event.properties;

  // Only handle text parts
  if (part.type !== "text") return;

  const rawText = part.text ?? "";
  if (!rawText.trim()) return;

  const { sessionID, id: partID } = part;
  const { api, editIntervalMs } = ctx;

  // Update the accumulator with the full text (replaces any delta-built text)
  partTextAccumulator.set(partID, rawText);

  const isFinal = part.state === "complete";
  const html = markdownToTelegramHtml(rawText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    const chatState = getChatState(chatId);
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

  // Clean up accumulator when part is complete
  if (isFinal) {
    clearAccumulated(partID);
  }
}

// ---------------------------------------------------------------------------
// Core streaming logic (unchanged state machine, but called from new handlers)
// ---------------------------------------------------------------------------

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
    chatState.stream.state === "FINAL"
  ) {
    // If transitioning from FINAL, reset stream state for the new response
    if (chatState.stream.state === "FINAL") {
      chatState.stream.chunks = [];
      chatState.stream.messageId = null;
      chatState.stream.lastSentText = "";
      chatState.stream.streamGeneration++;
    }
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
