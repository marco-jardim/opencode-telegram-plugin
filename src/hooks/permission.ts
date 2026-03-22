import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  getAllChatIds,
  getChatState,
  registerCallback,
  type PendingPermission,
} from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { escapeHtml } from "../utils/format.js";
import { safeSend } from "../utils/safeSend.js";

export interface HookContext {
  api: Api<RawApi>;
  editIntervalMs: number;
}

interface PermissionAskedEvent {
  type: "permission.asked";
  properties: {
    sessionID: string;
    id: string;
    tool: string;
    description: string;
  };
}

export function handlePermissionAsked(
  event: PermissionAskedEvent,
  ctx: HookContext,
): void {
  const { sessionID, id: permissionId, tool, description } = event.properties;
  const { api } = ctx;

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    const chatState = getChatState(chatId);

    const approveKey = registerCallback("perm_approve", {
      permissionId,
      sessionId: sessionID,
    });
    const alwaysKey = registerCallback("perm_always", {
      permissionId,
      sessionId: sessionID,
    });
    const denyKey = registerCallback("perm_deny", {
      permissionId,
      sessionId: sessionID,
    });

    const keyboard = new InlineKeyboard()
      .text("✅ Approve", approveKey)
      .text("✅ Always", alwaysKey)
      .text("❌ Deny", denyKey);

    const messageText =
      `🔐 <b>Permission requested</b>\n\n` +
      `<b>Tool:</b> <code>${escapeHtml(tool)}</code>\n` +
      escapeHtml(description) +
      `\n\n<i>Reply YES, ALWAYS, or NO</i>`;

    void (async () => {
      const result = await safeSend(() =>
        api.sendMessage(chatId, messageText, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        }),
      );

      const telegramMessageId =
        result.ok && result.messageId !== undefined ? result.messageId : null;

      const pending: PendingPermission = {
        permissionId,
        sessionId: sessionID,
        tool,
        description,
        telegramMessageId,
        timestamp: Date.now(),
      };

      chatState.pendingPermissions.set(permissionId, pending);
    })();
  }
}
