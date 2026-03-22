import type { Api, RawApi } from "grammy";
import {
  getAllChatIds,
  getChatState,
} from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { markdownToTelegramHtml, stripHtml } from "../utils/format.js";
import { chunkMessage } from "../utils/chunk.js";
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
// Track assistant message IDs
// ---------------------------------------------------------------------------

const assistantMessageIds = new Set<string>();

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
// Per-chat streaming context
// Simple model: store latest text, use setInterval to periodically edit.
// ---------------------------------------------------------------------------

interface ChatStreamCtx {
  latestRawText: string;
  latestHtml: string;
  isFinal: boolean;
  editTimer: ReturnType<typeof setInterval> | null;
  api: Api<RawApi>;
  editIntervalMs: number;
  editing: boolean;
  /** True while the initial sendMessage is in-flight */
  sending: boolean;
}

const chatStreamCtx = new Map<number, ChatStreamCtx>();

// Check if a given sctx is still the active context for a chat
function isActive(chatId: number, sctx: ChatStreamCtx): boolean {
  return chatStreamCtx.get(chatId) === sctx;
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
  if (!isAssistantMessage(messageID)) return;

  const fullText = appendDelta(partID, delta);
  if (!fullText.trim()) return;

  const { api, editIntervalMs } = ctx;
  const html = markdownToTelegramHtml(fullText);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;
    updateChatStream(chatId, html, fullText, false, api, editIntervalMs);
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
    updateChatStream(chatId, html, rawText, isFinal, api, editIntervalMs);
  }

  if (isFinal) {
    clearAccumulated(partID);
  }
}

// ---------------------------------------------------------------------------
// Update chat stream context — creates initial send or updates latest text
// ---------------------------------------------------------------------------

function updateChatStream(
  chatId: number,
  html: string,
  rawText: string,
  isFinal: boolean,
  api: Api<RawApi>,
  editIntervalMs: number,
): void {
  let sctx = chatStreamCtx.get(chatId);

  if (!sctx) {
    // First text — send initial message
    sctx = {
      latestRawText: rawText,
      latestHtml: html,
      isFinal,
      editTimer: null,
      api,
      editIntervalMs,
      editing: false,
      sending: true,
    };
    chatStreamCtx.set(chatId, sctx);
    void sendInitialMessage(chatId, sctx);
    return;
  }

  // Update latest text
  sctx.latestRawText = rawText;
  sctx.latestHtml = html;
  if (isFinal) {
    sctx.isFinal = true;
    void doFinalEdit(chatId, sctx);
  }
}

// ---------------------------------------------------------------------------
// Send the initial message, then start the periodic edit timer
// ---------------------------------------------------------------------------

async function sendInitialMessage(chatId: number, sctx: ChatStreamCtx): Promise<void> {
  const chatState = getChatState(chatId);

  if (!chatState.typingStop) {
    chatState.typingStop = startTyping(sctx.api, chatId);
  }

  const chunks = chunkMessage(sctx.latestHtml);
  if (chunks.length === 0) {
    sctx.sending = false;
    return;
  }

  let sentMsg: Awaited<ReturnType<typeof sctx.api.sendMessage>> | null = null;
  try {
    sentMsg = await sctx.api.sendMessage(chatId, chunks[0], { parse_mode: "HTML" });
  } catch {
    // Fallback to plain text
    try {
      sentMsg = await sctx.api.sendMessage(chatId, stripHtml(sctx.latestHtml));
    } catch {
      sctx.sending = false;
      cleanupStream(chatId);
      return;
    }
  }

  // After await: check if this context was cleaned up while we were sending
  if (!isActive(chatId, sctx)) {
    sctx.sending = false;
    return;
  }

  chatState.stream.messageId = sentMsg.message_id;
  chatState.stream.state = "SENT";
  chatState.stream.lastSentText = sctx.latestRawText;
  sctx.sending = false;

  // Send overflow chunks
  for (let i = 1; i < chunks.length; i++) {
    if (!isActive(chatId, sctx)) return;
    const r = await safeSend(() =>
      sctx.api.sendMessage(chatId, chunks[i], { parse_mode: "HTML" }),
    );
    if (r.ok && r.messageId !== undefined) {
      chatState.stream.chunks.push(r.messageId);
    }
  }

  // After sending overflow: recheck
  if (!isActive(chatId, sctx)) return;

  // If already final, do one last edit and stop
  if (sctx.isFinal) {
    if (sctx.latestRawText !== chatState.stream.lastSentText) {
      await doEdit(chatId, sctx);
    }
    cleanupStream(chatId);
    return;
  }

  // Start periodic edit timer (only if still active)
  if (!isActive(chatId, sctx)) return;
  sctx.editTimer = setInterval(() => {
    if (!isActive(chatId, sctx)) {
      clearInterval(sctx.editTimer!);
      sctx.editTimer = null;
      return;
    }
    void doEdit(chatId, sctx);
  }, sctx.editIntervalMs);
  if (typeof sctx.editTimer === "object" && "unref" in sctx.editTimer) {
    sctx.editTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Periodic edit — reads latest text and edits the Telegram message
// ---------------------------------------------------------------------------

async function doEdit(chatId: number, sctx: ChatStreamCtx): Promise<void> {
  if (sctx.editing || sctx.sending) return;
  if (!isActive(chatId, sctx)) return;
  sctx.editing = true;

  try {
    const chatState = getChatState(chatId);
    const msgId = chatState.stream.messageId;
    if (msgId === null) return;
    if (sctx.latestRawText === chatState.stream.lastSentText) return;

    const editChunks = chunkMessage(sctx.latestHtml);
    if (editChunks.length === 0) return;

    const editResult = await safeSend(() =>
      sctx.api.editMessageText(chatId, msgId, editChunks[0], { parse_mode: "HTML" }),
    );

    if (!editResult.ok && editResult.reason === "parse error") {
      await safeSend(() =>
        sctx.api.editMessageText(chatId, msgId, stripHtml(editChunks[0])),
      );
    }

    chatState.stream.lastSentText = sctx.latestRawText;

    // Sync overflow chunks
    for (let i = 1; i < editChunks.length; i++) {
      const existingId = chatState.stream.chunks[i - 1];
      if (existingId !== undefined) {
        const r = await safeSend(() =>
          sctx.api.editMessageText(chatId, existingId, editChunks[i], { parse_mode: "HTML" }),
        );
        if (!r.ok && r.reason === "parse error") {
          await safeSend(() =>
            sctx.api.editMessageText(chatId, existingId, stripHtml(editChunks[i])),
          );
        }
      } else {
        const r = await safeSend(() =>
          sctx.api.sendMessage(chatId, editChunks[i], { parse_mode: "HTML" }),
        );
        if (r.ok && r.messageId !== undefined) {
          chatState.stream.chunks.push(r.messageId);
        }
      }
    }

    // Delete stale overflow messages
    const excessStart = editChunks.length - 1;
    if (excessStart < chatState.stream.chunks.length) {
      for (let j = chatState.stream.chunks.length - 1; j >= excessStart; j--) {
        void safeSend(() => sctx.api.deleteMessage(chatId, chatState.stream.chunks[j]));
      }
      chatState.stream.chunks.length = Math.max(excessStart, 0);
    }
  } finally {
    sctx.editing = false;
  }
}

// ---------------------------------------------------------------------------
// Final edit — stop timer, do one last edit, cleanup
// ---------------------------------------------------------------------------

async function doFinalEdit(chatId: number, sctx: ChatStreamCtx): Promise<void> {
  if (sctx.editTimer) {
    clearInterval(sctx.editTimer);
    sctx.editTimer = null;
  }

  // Wait for sending/editing to finish (bail if context was cleaned up externally)
  let waitCount = 0;
  while (sctx.editing || sctx.sending) {
    if (!isActive(chatId, sctx) || ++waitCount > 200) return; // 200 × 50ms = 10s max
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!isActive(chatId, sctx)) return;

  const chatState = getChatState(chatId);
  if (sctx.latestRawText !== chatState.stream.lastSentText && chatState.stream.messageId !== null) {
    await doEdit(chatId, sctx);
  }

  if (isActive(chatId, sctx)) {
    cleanupStream(chatId);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanupStream(chatId: number): void {
  const sctx = chatStreamCtx.get(chatId);
  if (sctx?.editTimer) {
    clearInterval(sctx.editTimer);
  }
  chatStreamCtx.delete(chatId);

  const chatState = getChatState(chatId);
  chatState.typingStop?.();
  chatState.typingStop = null;
  chatState.stream.state = "FINAL";
}
