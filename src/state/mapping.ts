import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

    for (const item of parsed as ChatMapping[]) {
      if (typeof item.chatId === "number") {
        mappings.set(item.chatId, item);
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
      chatId,
      lastSessionId: null,
      username: null,
      firstSeen: now,
      lastActive: now,
      ...data,
    });
  }

  saveMappings();
}

export function getAllMappings(): ChatMapping[] {
  return Array.from(mappings.values());
}

export function saveMappings(): void {
  if (!filePath) return;

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const data = JSON.stringify(Array.from(mappings.values()), null, 2);
  writeFileSync(filePath, data, "utf-8");
}
