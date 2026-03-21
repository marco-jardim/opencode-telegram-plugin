import { getChatState } from "./store.js";

export type SessionMode = "attached" | "independent" | "detached";

export function getActiveSessionId(chatId: number): string | null {
  const state = getChatState(chatId);
  switch (state.mode) {
    case "attached":
      return state.attachedSessionId;
    case "independent":
      return state.independentSessionId;
    case "detached":
      return null;
  }
}

export function attachSession(chatId: number, sessionId: string): void {
  const state = getChatState(chatId);
  state.mode = "attached";
  state.attachedSessionId = sessionId;
}

export function detachSession(chatId: number): void {
  const state = getChatState(chatId);
  state.mode = "detached";
  state.attachedSessionId = null;
}

export function startIndependentSession(chatId: number, sessionId: string): void {
  const state = getChatState(chatId);
  state.mode = "independent";
  state.independentSessionId = sessionId;
}

export function getMode(chatId: number): SessionMode {
  return getChatState(chatId).mode;
}
