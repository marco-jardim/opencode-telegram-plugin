export type StreamState = "IDLE" | "PENDING_SEND" | "SENT" | "EDITING" | "FINAL";

export interface StreamTracker {
  state: StreamState;
  messageId: number | null;
  lastSentText: string;
  sessionId: string | null;
  messageIdOC: string | null;
  chunks: number[];
  streamGeneration: number;
}

export interface PendingPermission {
  permissionId: string;
  sessionId: string;
  tool: string;
  description: string;
  telegramMessageId: number | null;
  timestamp: number;
}

export interface ChatState {
  chatId: number;
  mode: "attached" | "independent" | "detached";
  attachedSessionId: string | null;
  independentSessionId: string | null;
  stream: StreamTracker;
  pendingPermissions: Map<string, PendingPermission>;
  typingStop: (() => void) | null;
}

export interface CallbackEntry {
  action: string;
  data: Record<string, string>;
  expiresAt: number;
}

const DEFAULT_CALLBACK_TTL_MS = 600_000; // 10 minutes
const CALLBACK_KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CALLBACK_KEY_LENGTH = 6;

const chatStates = new Map<number, ChatState>();
const callbackRegistry = new Map<string, CallbackEntry>();

function makeDefaultStream(): StreamTracker {
  return {
    state: "IDLE",
    messageId: null,
    lastSentText: "",
    sessionId: null,
    messageIdOC: null,
    chunks: [],
    streamGeneration: 0,
  };
}

function makeDefaultChatState(chatId: number): ChatState {
  return {
    chatId,
    mode: "detached",
    attachedSessionId: null,
    independentSessionId: null,
    stream: makeDefaultStream(),
    pendingPermissions: new Map(),
    typingStop: null,
  };
}

export function getChatState(chatId: number): ChatState {
  let state = chatStates.get(chatId);
  if (!state) {
    state = makeDefaultChatState(chatId);
    chatStates.set(chatId, state);
  }
  return state;
}

export function deleteChatState(chatId: number): void {
  chatStates.delete(chatId);
}

export function getAllChatIds(): number[] {
  return Array.from(chatStates.keys());
}

export function resetStream(chatId: number): void {
  const state = getChatState(chatId);
  const nextGen = state.stream.streamGeneration + 1;
  state.stream = makeDefaultStream();
  state.stream.streamGeneration = nextGen;
}

export function cleanupChatStream(chatId: number): void {
  const state = getChatState(chatId);
  state.typingStop?.();
  state.typingStop = null;
  resetStream(chatId);
}

function generateKey(): string {
  let key = "";
  for (let i = 0; i < CALLBACK_KEY_LENGTH; i++) {
    key += CALLBACK_KEY_CHARS[Math.floor(Math.random() * CALLBACK_KEY_CHARS.length)];
  }
  return key;
}

export function registerCallback(
  action: string,
  data: Record<string, string>,
  ttlMs: number = DEFAULT_CALLBACK_TTL_MS,
): string {
  let key: string;
  do {
    key = generateKey();
  } while (callbackRegistry.has(key));

  callbackRegistry.set(key, {
    action,
    data,
    expiresAt: Date.now() + ttlMs,
  });

  return key;
}

export function resolveCallback(key: string): CallbackEntry | null {
  const entry = callbackRegistry.get(key);
  if (!entry) return null;

  callbackRegistry.delete(key);

  if (Date.now() > entry.expiresAt) return null;

  return entry;
}

export function cleanExpiredCallbacks(): void {
  const now = Date.now();
  for (const [key, entry] of callbackRegistry) {
    if (now > entry.expiresAt) {
      callbackRegistry.delete(key);
    }
  }

  // Also sweep expired pending permissions across all chats.
  // Permissions share the same TTL as callbacks (10 minutes).
  for (const state of chatStates.values()) {
    for (const [permId, perm] of state.pendingPermissions) {
      if (now - perm.timestamp > DEFAULT_CALLBACK_TTL_MS) {
        state.pendingPermissions.delete(permId);
      }
    }
  }
}
