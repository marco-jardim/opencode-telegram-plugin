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

// ---------------------------------------------------------------------------
// Event shapes
//
// The SDK defines two event shapes:
// 1. "permission.asked" — legacy event shape with { sessionID, id, tool, description }
// 2. "permission.updated" — SDK standard with { id, title, metadata, sessionID, ... }
//
// We handle BOTH and normalize to the same display logic.
// ---------------------------------------------------------------------------

interface PermissionAskedEvent {
  type: "permission.asked";
  properties: {
    sessionID: string;
    id: string;
    tool?: string;
    description?: string;
    // SDK Permission type fields (may also appear here)
    title?: string;
    metadata?: Record<string, unknown>;
  };
}

interface PermissionUpdatedEvent {
  type: "permission.updated";
  properties: {
    id: string;
    type?: string;
    pattern?: string | string[];
    sessionID: string;
    messageID?: string;
    callID?: string;
    title: string;
    metadata: Record<string, unknown>;
    time?: { created: number };
  };
}

// Track which permissions we've already sent messages for
const sentPermissions = new Set<string>();

// ---------------------------------------------------------------------------
// Normalize event → display fields
// ---------------------------------------------------------------------------

interface PermissionDisplay {
  permissionId: string;
  sessionID: string;
  toolName: string;
  description: string;
}

function normalizePermission(
  props: PermissionAskedEvent["properties"] | PermissionUpdatedEvent["properties"],
): PermissionDisplay {
  const permissionId = props.id;
  const sessionID = props.sessionID;

  // Tool name: prefer "tool" field (asked event), fall back to "title" (updated event)
  const toolName =
    ("tool" in props && typeof props.tool === "string" && props.tool)
      ? props.tool
      : ("title" in props && typeof props.title === "string" && props.title)
        ? props.title
        : "unknown";

  // Description: prefer "description" field, then build from metadata
  let description = "";
  if ("description" in props && typeof props.description === "string" && props.description) {
    description = props.description;
  } else if ("metadata" in props && props.metadata && typeof props.metadata === "object") {
    // Try to build a readable description from metadata
    const meta = props.metadata;
    const parts: string[] = [];

    // Common metadata fields for permissions
    if (typeof meta.command === "string") parts.push(`Command: ${meta.command}`);
    if (typeof meta.path === "string") parts.push(`Path: ${meta.path}`);
    if (typeof meta.file === "string") parts.push(`File: ${meta.file}`);
    if (typeof meta.url === "string") parts.push(`URL: ${meta.url}`);
    if (typeof meta.description === "string") parts.push(meta.description);

    // For question-type permissions, show the question and options
    if (typeof meta.question === "string") parts.push(meta.question);
    if (typeof meta.message === "string") parts.push(meta.message);
    if (Array.isArray(meta.options)) {
      const opts = meta.options
        .map((o: unknown) => typeof o === "string" ? o : (typeof o === "object" && o && "label" in o) ? String((o as any).label) : String(o))
        .slice(0, 10);
      if (opts.length > 0) parts.push("Options: " + opts.join(", "));
    }

    if (parts.length === 0) {
      // Fallback: dump all string values from metadata
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === "string" && v.length < 200) {
          parts.push(`${k}: ${v}`);
        }
      }
    }

    description = parts.join("\n");
  }

  if (!description) {
    description = `Permission for: ${toolName}`;
  }

  return { permissionId, sessionID, toolName, description };
}

// ---------------------------------------------------------------------------
// Send permission message to Telegram
// ---------------------------------------------------------------------------

function sendPermissionMessage(
  display: PermissionDisplay,
  api: Api<RawApi>,
): void {
  const { permissionId, sessionID, toolName, description } = display;

  // Skip if we already sent this permission
  if (sentPermissions.has(permissionId)) return;
  sentPermissions.add(permissionId);

  // Clean old entries (keep max 100)
  if (sentPermissions.size > 100) {
    const entries = Array.from(sentPermissions);
    for (let i = 0; i < entries.length - 50; i++) {
      sentPermissions.delete(entries[i]);
    }
  }

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
      `<b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n` +
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
        tool: toolName,
        description,
        telegramMessageId,
        timestamp: Date.now(),
      };

      chatState.pendingPermissions.set(permissionId, pending);
    })();
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export function handlePermissionAsked(
  event: PermissionAskedEvent,
  ctx: HookContext,
): void {
  const display = normalizePermission(event.properties);
  sendPermissionMessage(display, ctx.api);
}

export function handlePermissionUpdated(
  event: PermissionUpdatedEvent,
  ctx: HookContext,
): void {
  const display = normalizePermission(event.properties);
  sendPermissionMessage(display, ctx.api);
}
