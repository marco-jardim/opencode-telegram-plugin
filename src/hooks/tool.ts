import type { Api, RawApi } from "grammy";
import { getAllChatIds, getChatState } from "../state/store.js";
import { getActiveSessionId } from "../state/mode.js";
import { escapeHtml } from "../utils/format.js";
import { safeSend } from "../utils/safeSend.js";

export interface HookContext {
  api: Api<RawApi>;
  editIntervalMs: number;
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
  // Match common long-running prefixes
  return (
    key.startsWith("bash") ||
    key.startsWith("browser") ||
    key.startsWith("exec") ||
    key.startsWith("run")
  );
}

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

    if (isNotableTool(tool)) {
      // Send a brief visible status for high-impact tools
      void safeSend(() =>
        api.sendMessage(
          chatId,
          `🔧 Running <code>${escapeHtml(tool)}</code>…`,
          { parse_mode: "HTML" },
        ),
      );
    } else {
      // For lightweight tools, just keep the typing indicator alive
      void safeSend(() => api.sendChatAction(chatId, "typing"));
    }
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

    // Keep the chat action alive if a stream response is still incoming
    if (stream.state !== "IDLE" && stream.state !== "FINAL") {
      void safeSend(() => api.sendChatAction(chatId, "typing"));
    }
  }
}
