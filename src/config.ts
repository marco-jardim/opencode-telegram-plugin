import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  botToken: string | null;
  allowedUsers: string | null;
  editIntervalMs: number | null;
  autoAttach: boolean | null;
}

type ConfigKey = keyof TelegramConfig;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILE = join(CONFIG_DIR, "telegram.json");

export function getConfigPath(): string {
  return CONFIG_FILE;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read the config file from disk. Returns an empty config on any error. */
export function readConfigFile(): Partial<TelegramConfig> {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;

    const result: Partial<TelegramConfig> = {};
    if (typeof obj.botToken === "string") result.botToken = obj.botToken;
    if (typeof obj.allowedUsers === "string") result.allowedUsers = obj.allowedUsers;
    if (typeof obj.editIntervalMs === "number" && Number.isFinite(obj.editIntervalMs)) {
      result.editIntervalMs = obj.editIntervalMs;
    }
    if (typeof obj.autoAttach === "boolean") result.autoAttach = obj.autoAttach;
    return result;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Merge partial config into the file (atomic write). */
export function writeConfigFile(updates: Partial<TelegramConfig>): void {
  const existing = readConfigFile();
  const merged = { ...existing, ...updates };

  // Remove null/undefined entries so the file stays clean
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null && v !== undefined) {
      clean[k] = v;
    }
  }

  mkdirSync(CONFIG_DIR, { recursive: true });

  const data = JSON.stringify(clean, null, 2) + "\n";
  const tmpPath = CONFIG_FILE + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    writeFileSync(tmpPath, data, "utf-8");
    renameSync(tmpPath, CONFIG_FILE);
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (existsSync(tmpPath)) {
        const { unlinkSync } = require("node:fs") as typeof import("node:fs");
        unlinkSync(tmpPath);
      }
    } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete a key
// ---------------------------------------------------------------------------

export function deleteConfigKey(key: ConfigKey): void {
  const existing = readConfigFile();
  delete existing[key];
  writeConfigFile(existing);
}

// ---------------------------------------------------------------------------
// Resolve config: file < env vars
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  botToken: string | null;
  allowedUsers: string;
  editIntervalMs: number;
  autoAttach: boolean;
  /** Where the bot token came from */
  tokenSource: "env" | "config" | "none";
}

/**
 * Resolve final config by layering env vars over the config file.
 *
 * Priority: env vars > config file > defaults.
 */
export function resolveConfig(): ResolvedConfig {
  const file = readConfigFile();

  // Bot token: env > file
  const envToken = process.env["TELEGRAM_BOT_TOKEN"];
  let botToken: string | null = null;
  let tokenSource: ResolvedConfig["tokenSource"] = "none";
  if (envToken) {
    botToken = envToken;
    tokenSource = "env";
  } else if (file.botToken) {
    botToken = file.botToken;
    tokenSource = "config";
  }

  // Allowed users: env > file > ""
  const allowedUsers =
    process.env["TELEGRAM_ALLOWED_USERS"] ?? file.allowedUsers ?? "";

  // Edit interval: env > file > 2500
  const envInterval = Number(process.env["TELEGRAM_EDIT_INTERVAL_MS"]);
  let editIntervalMs = 2500;
  if (Number.isFinite(envInterval) && envInterval > 0) {
    editIntervalMs = envInterval;
  } else if (
    file.editIntervalMs !== null &&
    file.editIntervalMs !== undefined &&
    Number.isFinite(file.editIntervalMs) &&
    file.editIntervalMs > 0
  ) {
    editIntervalMs = file.editIntervalMs;
  }

  // Auto-attach: env > file > true
  const envAutoAttach = process.env["TELEGRAM_AUTO_ATTACH"];
  let autoAttach = true;
  if (envAutoAttach !== undefined) {
    autoAttach = envAutoAttach !== "false";
  } else if (file.autoAttach !== null && file.autoAttach !== undefined) {
    autoAttach = file.autoAttach;
  }

  return { botToken, allowedUsers, editIntervalMs, autoAttach, tokenSource };
}

// ---------------------------------------------------------------------------
// Status summary (for /telegram status)
// ---------------------------------------------------------------------------

export function getConfigStatus(): string {
  const file = readConfigFile();
  const resolved = resolveConfig();

  const lines: string[] = [];
  lines.push("**Telegram Plugin Configuration**\n");

  // Token
  if (resolved.botToken) {
    const masked = resolved.botToken.slice(0, 6) + "..." + resolved.botToken.slice(-4);
    lines.push(`- **Bot Token**: \`${masked}\` (from ${resolved.tokenSource})`);
  } else {
    lines.push("- **Bot Token**: _not set_");
  }

  // Allowed users
  if (resolved.allowedUsers) {
    lines.push(`- **Allowed Users**: \`${resolved.allowedUsers}\``);
  } else {
    lines.push("- **Allowed Users**: _all users_ (no restriction)");
  }

  // Edit interval
  lines.push(`- **Edit Interval**: ${resolved.editIntervalMs}ms`);

  // Auto-attach
  lines.push(`- **Auto-Attach**: ${resolved.autoAttach ? "enabled" : "disabled"}`);

  // Config file
  lines.push(`\n**Config file**: \`${CONFIG_FILE}\``);
  if (existsSync(CONFIG_FILE)) {
    const keys = Object.keys(file);
    lines.push(`  - Exists with ${keys.length} key(s): ${keys.map(k => `\`${k}\``).join(", ") || "_empty_"}`);
  } else {
    lines.push("  - Does not exist yet");
  }

  // Env var overrides
  const envOverrides: string[] = [];
  if (process.env["TELEGRAM_BOT_TOKEN"]) envOverrides.push("TELEGRAM_BOT_TOKEN");
  if (process.env["TELEGRAM_ALLOWED_USERS"]) envOverrides.push("TELEGRAM_ALLOWED_USERS");
  if (process.env["TELEGRAM_EDIT_INTERVAL_MS"]) envOverrides.push("TELEGRAM_EDIT_INTERVAL_MS");
  if (process.env["TELEGRAM_AUTO_ATTACH"]) envOverrides.push("TELEGRAM_AUTO_ATTACH");

  if (envOverrides.length > 0) {
    lines.push(`\n**Active env overrides**: ${envOverrides.map(e => `\`${e}\``).join(", ")}`);
  }

  return lines.join("\n");
}
