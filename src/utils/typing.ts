import type { Api, RawApi } from "grammy";

/**
 * Send a "typing" chat action immediately, then repeat every 4 500 ms to keep
 * the indicator alive while the bot is streaming a response.
 *
 * @param api    The grammY `Api` instance.
 * @param chatId The target chat ID.
 * @returns A stop function — call it to clear the interval.
 *
 * All errors are silently swallowed so a transient Telegram hiccup never
 * interrupts the main response flow.
 */
export function startTyping(api: Api<RawApi>, chatId: number): () => void {
  // Fire immediately so the indicator appears without delay.
  void api.sendChatAction(chatId, "typing").catch(() => undefined);

  const intervalId = setInterval(() => {
    void api.sendChatAction(chatId, "typing").catch(() => undefined);
  }, 4500);

  return () => {
    clearInterval(intervalId);
  };
}
