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
  editIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Event shapes (matching actual OpenCode SDK events)
// ---------------------------------------------------------------------------

export interface MessageUpdatedEvent {
  type: "message.updated";
  properties: {
    info: {
      id: string;
      sessionID: string;
      role: string;
      [key: string]: unknown;
    };
  };
}

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
// Track which messageIDs belong to assistant (vs user)
// ---------------------------------------------------------------------------

const assistantMessageIds = new Set<string>();

/** Called when message.updated fires — records assistant message IDs */
export function handleMessageInfo(event: MessageUpdatedEvent): void {
  const { info } = event.properties;
  if (info.role === "assistant") {
    assistantMessageIds.add(info.id);
  }
}

function isAssistantMessage(messageID: string): boolean {
  return assistantMessageIds.has(messageID);
}

// ---------------------------------------------------------------------------
// Per-part accumulated text (built from deltas)
// ---------------------------------------------------------------------------

const partTextAccumulator = new Map<string, string>();

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
// Per-chat: latest text + html for the current stream
// The throttled doEdit reads from here to always use the freshest text.
// ---------------------------------------------------------------------------

interface LatestText {
  rawText: string;
  html: string;
  isFinal: boolean;
}

const latestTextByChat = new Map<number, LatestText>();

// ---------------------------------------------------------------------------
// Per-chat: text buffered during PENDING_SEND
// ---------------------------------------------------------------------------

const pendingTextByChat = new Map<number, LatestText>();

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
  const { sessionID, messageID, partID, field, delta } = event.properties;
  if (field !== "text") return;

  // Only stream assistant messages
  if (!isAssistantMessage(messageID)) return;

  const fullText = appendDelta(partID, delta);
  if (!fullText.trim()) return;

  const { api, editIntervalMs } = ctx;
  const html = markdownToTelegramHtml(fullText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;
    const chatState = getChatState(chatId);
    // Always update latest text for this chat
    latestTextByChat.set(chatId, { rawText: fullText, html, isFinal: false });
    dispatchToChat(chatId, chatState, html, fullText, false, api, editIntervalMs);
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
  if (part.type !== "text") return;

  // Only stream assistant messages
  if (!isAssistantMessage(part.messageID)) return;

  const rawText = part.text ?? "";
  if (!rawText.trim()) return;

  const { sessionID, id: partID } = part;
  const { api, editIntervalMs } = ctx;

  partTextAccumulator.set(partID, rawText);

  const isFinal = part.state === "complete";
  const html = markdownToTelegramHtml(rawText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;
    const chatState = getChatState(chatId);
    latestTextByChat.set(chatId, { rawText, html, isFinal });
    dispatchToChat(chatId, chatState, html, rawText, isFinal, api, editIntervalMs);
  }

  if (isFinal) {
    clearAccumulated(partID);
  }
}

// ---------------------------------------------------------------------------
// Dispatch: if PENDING_SEND, buffer; otherwise process
// ---------------------------------------------------------------------------

function dispatchToChat(
  chatId: number,
  chatState: ChatState,
  html: string,
  rawText: string,
  isFinal: boolean,
  api: Api<RawApi>,
  editIntervalMs: number,
): void {
  if (chatState.stream.state === "PENDING_SEND") {
    pendingTextByChat.set(chatId, { rawText, html, isFinal });
    return;
  }

  void processStreamForChat(chatId, chatState, html, rawText, isFinal, api, editIntervalMs);
}

// ---------------------------------------------------------------------------
// Core streaming state machine
// ---------------------------------------------------------------------------

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
    if (chatState.stream.state === "FINAL") {
      chatState.stream.chunks = [];
      chatState.stream.messageId = null;
      chatState.stream.lastSentText = "";
      chatState.stream.streamGeneration++;
    }
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
      pendingTextByChat.delete(chatId);
      return;
    }

    chatState.stream.messageId = firstResult.messageId ?? null;
    chatState.stream.state = "SENT";
    chatState.stream.lastSentText = rawText;

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
      pendingTextByChat.delete(chatId);
      return;
    }

    // Catch up with text that arrived during PENDING_SEND
    const buffered = pendingTextByChat.get(chatId);
    pendingTextByChat.delete(chatId);
    if (buffered && buffered.rawText !== rawText) {
      void processStreamForChat(
        chatId, chatState, buffered.html, buffered.rawText,
        buffered.isFinal, api, editIntervalMs,
      );
    }
    return;
  }

  // ── Streaming edits ───────────────────────────────────────────────────────
  if (
    chatState.stream.state === "SENT" ||
    chatState.stream.state === "EDITING"
  ) {
    // Don't early-return based on rawText vs lastSentText here.
    // doEdit reads latestTextByChat and has its own no-op guard.
    chatState.stream.state = "EDITING";

    const capturedGeneration = chatState.stream.streamGeneration;

    // doEdit reads the LATEST text from latestTextByChat at execution time,
    // not the stale text from when the throttle was scheduled.
    const doEdit = async (): Promise<void> => {
      if (
        chatState.stream.streamGeneration !== capturedGeneration ||
        (chatState.stream.state !== "EDITING" &&
         chatState.stream.state !== "SENT")
      ) {
        return;
      }

      const msgId = chatState.stream.messageId;
      if (msgId === null) return;

      // Use the freshest text available
      const latest = latestTextByChat.get(chatId);
      const editHtml = latest ? latest.html : html;
      const editRawText = latest ? latest.rawText : rawText;

      if (editRawText === chatState.stream.lastSentText) return;

      const editChunks = chunkMessage(editHtml);
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

      chatState.stream.lastSentText = editRawText;

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

      const excessStart = editChunks.length - 1;
      if (excessStart < chatState.stream.chunks.length) {
        for (let j = chatState.stream.chunks.length - 1; j >= excessStart; j--) {
          void safeSend(() => api.deleteMessage(chatId, chatState.stream.chunks[j]));
        }
        chatState.stream.chunks.length = Math.max(excessStart, 0);
      }
    };

    if (isFinal) {
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
  chatState.typingStop?.();
  chatState.typingStop = null;

  const throttle = chatThrottles.get(chatId);
  if (throttle) {
    throttle.cancel();
    chatThrottles.delete(chatId);
  }

  chatState.stream.state = "FINAL";
  latestTextByChat.delete(chatId);
}
