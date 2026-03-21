import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface ChatMapping {
  chatId: number;
  lastSessionId: string | null;
  username: string | null;
  firstSeen: number;
  lastActive: number;
}

const mappings = new Map<number, ChatMapping>();
let filePath: string | null = null;

export function initMapping(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  filePath = join(dataDir, "chat-mappings.json");

  if (!existsSync(filePath)) return;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    for (const item of parsed) {
      if (item != null && typeof item === "object" && typeof (item as Record<string, unknown>).chatId === "number") {
        const m = item as Record<string, unknown>;
        const chatId = m.chatId as number;
        mappings.set(chatId, {
          chatId,
          lastSessionId: typeof m.lastSessionId === "string" ? m.lastSessionId : null,
          username: typeof m.username === "string" ? m.username : null,
          firstSeen: typeof m.firstSeen === "number" ? m.firstSeen : Date.now(),
          lastActive: typeof m.lastActive === "number" ? m.lastActive : Date.now(),
        });
      }
    }
  } catch {
    // Corrupt or unreadable file — start fresh
  }
}

export function getMapping(chatId: number): ChatMapping | null {
  return mappings.get(chatId) ?? null;
}

export function setMapping(chatId: number, data: Partial<ChatMapping>): void {
  const now = Date.now();
  const existing = mappings.get(chatId);

  if (existing) {
    mappings.set(chatId, {
      ...existing,
      ...data,
      chatId,
      lastActive: now,
    });
  } else {
    mappings.set(chatId, {
      lastSessionId: null,
      username: null,
      firstSeen: now,
      ...data,
      chatId,
      lastActive: now,
    });
  }

  scheduleSave();
}

export function getAllMappings(): ChatMapping[] {
  return Array.from(mappings.values());
}

function saveMappingsSync(): void {
  if (!filePath) return;

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(Array.from(mappings.values()), null, 2);
  const tmpPath = filePath + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { if (existsSync(tmpPath)) writeFileSync(tmpPath, "", "utf-8"); } catch { /* ignore */ }
    throw err;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveMappingsSync();
    } catch {
      // Non-fatal — data will be retried on next write
    }
  }, 500);
}

export function saveMappings(): void {
  scheduleSave();
}
