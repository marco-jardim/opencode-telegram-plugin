import { GrammyError, HttpError } from "grammy";

export type SendResult =
  | { ok: true; messageId?: number }
  | { ok: false; retry: boolean; reason: string; retryAfterMs?: number };

/**
 * Returns true when the error is a Telegram "message is not modified" error.
 * This is treated as a successful no-op by `safeSend`.
 */
export function isNotModifiedError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.description.includes("message is not modified")
  );
}

/**
 * Returns true when Telegram rejected the request due to malformed entities.
 */
export function isParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.description.includes("can't parse entities")
  );
}

/**
 * Returns true when the bot has been blocked by the user (HTTP 403).
 */
export function isBotBlockedError(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 403;
}

/**
 * Wrap any Telegram Bot API call with standardised error classification.
 *
 * | Condition                          | Result                                         |
 * |------------------------------------|------------------------------------------------|
 * | Success                            | `{ ok: true, messageId? }`                     |
 * | "message is not modified"          | `{ ok: true }` — silent no-op                  |
 * | HTTP 429 (rate limit)              | `{ ok: false, retry: true,  reason: "rate limited" }`  |
 * | "can't parse entities"             | `{ ok: false, retry: true,  reason: "parse error" }`   |
 * | HTTP 403 (bot blocked)             | `{ ok: false, retry: false, reason: "bot blocked" }`   |
 * | "message to edit not found"        | `{ ok: false, retry: false, reason: "message deleted" }` |
 * | Other GrammyError / HttpError      | `{ ok: false, retry: false, reason: <message> }` |
 */
export async function safeSend(
  fn: () => Promise<unknown>,
): Promise<SendResult> {
  try {
    const result = await fn();

    // Extract message_id when the API returns a Message object.
    let messageId: number | undefined;
    if (
      result !== null &&
      typeof result === "object" &&
      "message_id" in result
    ) {
      const id = (result as Record<string, unknown>).message_id;
      if (typeof id === "number") {
        messageId = id;
      }
    }

    return { ok: true, messageId };
  } catch (err: unknown) {
    // "message is not modified" is not a real error — content was already
    // up to date. Treat as success.
    if (isNotModifiedError(err)) {
      return { ok: true };
    }

    if (err instanceof GrammyError) {
      if (err.error_code === 429) {
        const retryAfter = err.parameters.retry_after;
        const retryAfterMs = typeof retryAfter === "number" ? retryAfter * 1000 : undefined;
        return { ok: false, retry: true, reason: "rate limited", retryAfterMs };
      }
      if (isParseError(err)) {
        return { ok: false, retry: true, reason: "parse error" };
      }
      if (isBotBlockedError(err)) {
        return { ok: false, retry: false, reason: "bot blocked" };
      }
      if (err.description.includes("message to edit not found")) {
        return { ok: false, retry: false, reason: "message deleted" };
      }
      return { ok: false, retry: false, reason: err.description };
    }

    if (err instanceof HttpError) {
      return { ok: false, retry: true, reason: err.message };
    }

    if (err instanceof Error) {
      return { ok: false, retry: false, reason: err.message };
    }

    return { ok: false, retry: false, reason: String(err) };
  }
}
