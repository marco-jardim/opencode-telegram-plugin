import type { Api, RawApi } from "grammy";
import { getAllChatIds, getChatState } from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { escapeHtml } from "../utils/format.js";
import { safeSend } from "../utils/safeSend.js";

export interface HookContext {
  api: Api<RawApi>;
  editIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Tool part types (from SDK ToolPart / ToolState)
// ---------------------------------------------------------------------------

interface ToolInput {
  [key: string]: unknown;
}

interface ToolStateRunning {
  status: "running";
  input: ToolInput;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
}

interface ToolStateCompleted {
  status: "completed";
  input: ToolInput;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number };
}

interface ToolStateError {
  status: "error";
  input: ToolInput;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
}

type ToolState =
  | { status: "pending"; input: ToolInput }
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

// ---------------------------------------------------------------------------
// Edit-related tool names (tools that produce file diffs)
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "write_file",
  "create_file",
  "patch",
  "multiEdit",
  "insert",
  "replace",
]);

function isEditTool(tool: string): boolean {
  const key = tool.toLowerCase().replace(/[^a-z_]/g, "");
  if (EDIT_TOOLS.has(key)) return true;
  return key.includes("edit") || key.includes("write") || key.includes("patch");
}

/**
 * Tools that are long-running or high-impact enough to warrant a visible
 * status message rather than a silent typing indicator.
 */
const NOTABLE_TOOLS = new Set([
  "bash",
  "browser",
  "computer",
  "curl",
  "docker",
  "edit",
  "execute",
  "find",
  "git",
  "grep",
  "node",
  "npm",
  "python",
  "read_file",
  "run",
  "search",
  "shell",
  "web_search",
  "write_file",
]);

function isNotableTool(tool: string): boolean {
  const key = tool.toLowerCase().replace(/[^a-z_]/g, "");
  if (NOTABLE_TOOLS.has(key)) return true;
  return (
    key.startsWith("bash") ||
    key.startsWith("browser") ||
    key.startsWith("exec") ||
    key.startsWith("run")
  );
}

// ---------------------------------------------------------------------------
// Track which tool invocations we've already sent messages for
// (avoid duplicate "running" / "completed" messages)
// ---------------------------------------------------------------------------

const sentToolMessages = new Map<string, { status: string; messageId?: number }>();

function toolKey(partId: string): string {
  return partId;
}

// Clean up old entries periodically (called from cleanExpiredCallbacks)
export function cleanExpiredToolMessages(): void {
  // Keep max 200 entries — simple LRU by deletion
  if (sentToolMessages.size > 200) {
    const keys = Array.from(sentToolMessages.keys());
    for (let i = 0; i < keys.length - 100; i++) {
      sentToolMessages.delete(keys[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Handle tool.execute.before / after (existing simple hooks)
// ---------------------------------------------------------------------------

export function handleToolBefore(
  event: {
    type: "tool.execute.before";
    properties: { sessionID: string; tool: string };
  },
  ctx: HookContext,
): void {
  const { sessionID, tool } = event.properties;
  const { api } = ctx;

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    // Just keep typing indicator alive — tool part updates handle the details
    void safeSend(() => api.sendChatAction(chatId, "typing"));
  }
}

export function handleToolAfter(
  event: {
    type: "tool.execute.after";
    properties: { sessionID: string; tool: string };
  },
  ctx: HookContext,
): void {
  const { sessionID } = event.properties;
  const { api } = ctx;

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== sessionID) continue;

    const { stream } = getChatState(chatId);
    if (stream.state !== "IDLE" && stream.state !== "FINAL") {
      void safeSend(() => api.sendChatAction(chatId, "typing"));
    }
  }
}

// ---------------------------------------------------------------------------
// Handle message.part.updated with type="tool" — rich tool status
// ---------------------------------------------------------------------------

export function handleToolPartUpdated(
  event: {
    type: "message.part.updated";
    properties: {
      part: {
        id: string;
        sessionID: string;
        messageID: string;
        type: "tool";
        tool: string;
        state: ToolState;
      };
    };
  },
  ctx: HookContext,
): void {
  const { part } = event.properties;
  const { api } = ctx;
  const key = toolKey(part.id);

  for (const chatId of getAllChatIds()) {
    if (getActiveSessionId(chatId) !== part.sessionID) continue;

    const prev = sentToolMessages.get(key);

    switch (part.state.status) {
      case "running": {
        // Send "running" notification only once per tool invocation
        if (prev?.status === "running" || prev?.status === "completed") break;

        const title = part.state.title || part.tool;
        const filePath = extractFilePath(part.state.input);
        const fileInfo = filePath ? `\n📄 <code>${escapeHtml(filePath)}</code>` : "";

        void (async () => {
          const result = await safeSend(() =>
            api.sendMessage(
              chatId,
              `🔧 <b>${escapeHtml(title)}</b>${fileInfo}`,
              { parse_mode: "HTML" },
            ),
          );
          sentToolMessages.set(key, {
            status: "running",
            messageId: result.ok ? result.messageId : undefined,
          });
        })();
        break;
      }

      case "completed": {
        // Skip if we already showed completed for this tool
        if (prev?.status === "completed") break;

        const title = part.state.title || part.tool;
        const filePath = extractFilePath(part.state.input);
        const duration = part.state.time.end - part.state.time.start;
        const durationStr = duration < 1000
          ? `${duration}ms`
          : `${(duration / 1000).toFixed(1)}s`;

        // For edit tools, show the diff output
        const output = part.state.output ?? "";
        const isEdit = isEditTool(part.tool);

        let body = `✅ <b>${escapeHtml(title)}</b>`;
        if (filePath) {
          body += `\n📄 <code>${escapeHtml(filePath)}</code>`;
        }
        body += ` <i>(${durationStr})</i>`;

        if (isEdit && output.trim()) {
          // Truncate diff to reasonable size for Telegram
          const diff = output.trim();
          const maxLen = 3500 - body.length;
          const truncated = diff.length > maxLen ? diff.slice(0, maxLen) + "\n…(truncated)" : diff;
          body += `\n<pre>${escapeHtml(truncated)}</pre>`;
        }

        // Try to edit the "running" message, otherwise send new
        void (async () => {
          if (prev?.messageId) {
            const editResult = await safeSend(() =>
              api.editMessageText(chatId, prev.messageId!, body, { parse_mode: "HTML" }),
            );
            if (!editResult.ok) {
              // Fallback: send new message
              await safeSend(() =>
                api.sendMessage(chatId, body, { parse_mode: "HTML" }),
              );
            }
          } else {
            await safeSend(() =>
              api.sendMessage(chatId, body, { parse_mode: "HTML" }),
            );
          }
          sentToolMessages.set(key, { status: "completed" });
        })();
        break;
      }

      case "error": {
        if (prev?.status === "completed" || prev?.status === "error") break;

        const errorMsg = part.state.error || "Unknown error";

        void (async () => {
          const body = `❌ <b>${escapeHtml(part.tool)}</b> failed\n<pre>${escapeHtml(errorMsg.slice(0, 2000))}</pre>`;
          if (prev?.messageId) {
            await safeSend(() =>
              api.editMessageText(chatId, prev.messageId!, body, { parse_mode: "HTML" }),
            );
          } else {
            await safeSend(() =>
              api.sendMessage(chatId, body, { parse_mode: "HTML" }),
            );
          }
          sentToolMessages.set(key, { status: "error" });
        })();
        break;
      }

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Handle file.edited event
// ---------------------------------------------------------------------------

export function handleFileEdited(
  event: {
    type: "file.edited";
    properties: { file: string };
  },
  ctx: HookContext,
): void {
  // file.edited is a lightweight notification — we already show detailed
  // info from the tool part updates. Only use this as a fallback if
  // somehow the tool part didn't fire. For now, we skip it to avoid
  // duplicate messages since handleToolPartUpdated covers the same info.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a file path from tool input parameters.
 * Different tools use different param names.
 */
function extractFilePath(input: ToolInput): string | null {
  // Common param names for file paths
  const keys = ["file_path", "filePath", "path", "file", "filename", "target"];
  for (const k of keys) {
    const val = input[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }

  // Check for nested command/args patterns
  if (typeof input.command === "string") {
    // For bash/shell tools, try to extract filename from command
    return null;
  }

  return null;
}
