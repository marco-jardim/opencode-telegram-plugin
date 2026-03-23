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
        const command = isBashTool(part.tool) ? extractCommand(part.state.input) : null;

        let msgText = `🔧 <b>${escapeHtml(title)}</b>`;
        if (filePath) {
          msgText += `\n📄 <code>${escapeHtml(filePath)}</code>`;
        }
        if (command) {
          const cmdPreview = command.length > 200 ? command.slice(0, 200) + "…" : command;
          msgText += `\n<pre>$ ${escapeHtml(cmdPreview)}</pre>`;
        }

        void (async () => {
          const result = await safeSend(() =>
            api.sendMessage(chatId, msgText, { parse_mode: "HTML" }),
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

        const output = part.state.output ?? "";
        const isEdit = isEditTool(part.tool);
        const isBash = isBashTool(part.tool);
        const command = isBash ? extractCommand(part.state.input) : null;

        let body = `✅ <b>${escapeHtml(title)}</b>`;
        if (filePath) {
          body += `\n📄 <code>${escapeHtml(filePath)}</code>`;
        }
        body += ` <i>(${durationStr})</i>`;

        if (isBash && command) {
          const cmdPreview = command.length > 100 ? command.slice(0, 100) + "…" : command;
          body += `\n<pre>$ ${escapeHtml(cmdPreview)}</pre>`;
        }

        // For edit tools, show the diff from input (oldString → newString)
        if (isEdit) {
          const diff = buildEditDiff(part.state.input);
          if (diff) {
            const maxLen = 3500 - body.length;
            const truncated = diff.length > maxLen ? diff.slice(0, maxLen) + "\n…(truncated)" : diff;
            body += `\n<pre>${escapeHtml(truncated)}</pre>`;
          }
        }

        // For bash tools, show the command output
        if (isBash && output.trim()) {
          const maxLen = 3500 - body.length;
          const outTrimmed = output.trim();
          const truncated = outTrimmed.length > maxLen ? outTrimmed.slice(0, maxLen) + "\n…(truncated)" : outTrimmed;
          body += `\n<pre>${escapeHtml(truncated)}</pre>`;
        }

        // Try to edit the "running" message, otherwise send new
        void (async () => {
          if (prev?.messageId) {
            const editResult = await safeSend(() =>
              api.editMessageText(chatId, prev.messageId!, body, { parse_mode: "HTML" }),
            );
            if (!editResult.ok) {
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
  return null;
}

/**
 * Extract the shell command from a bash/shell tool input.
 */
function extractCommand(input: ToolInput): string | null {
  for (const k of ["command", "cmd", "script"]) {
    const val = input[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

/**
 * For edit tools, build a readable diff from the tool input (oldString/newString).
 */
function buildEditDiff(input: ToolInput): string | null {
  const oldStr = input.oldString ?? input.old_string ?? input.old_str ?? input.search;
  const newStr = input.newString ?? input.new_string ?? input.new_str ?? input.replace;

  if (typeof oldStr !== "string" && typeof newStr !== "string") return null;

  const lines: string[] = [];
  if (typeof oldStr === "string" && oldStr.trim()) {
    const oldLines = oldStr.split("\n");
    for (const line of oldLines) {
      lines.push(`- ${line}`);
    }
  }
  if (typeof newStr === "string" && newStr.trim()) {
    const newLines = newStr.split("\n");
    for (const line of newLines) {
      lines.push(`+ ${line}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Check if a tool is a bash/shell command tool.
 */
function isBashTool(tool: string): boolean {
  const key = tool.toLowerCase().replace(/[^a-z_]/g, "");
  return key === "bash" || key === "shell" || key === "execute" || key === "run" ||
    key.startsWith("bash") || key.startsWith("shell") || key.startsWith("exec");
}
