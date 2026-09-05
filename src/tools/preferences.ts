import { db } from "../db/index.js";
import { fail, type ToolResult } from "./shared.js";

/**
 * Standing preferences: default payment mode, preferred brand for an
 * ambiguous generic term ("atta" -> "Aashirvaad Atta 5kg"), shop name/GSTIN
 * for invoices. Stored in SQLite, so they survive a /new chat and a process
 * restart alike - brief hard-part #9 ("memory lives outside the context
 * window, not just in it").
 */
export function readPreference(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM preferences WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function writePreference(key: string, value: string) {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

export function setPreference(input: { key: string; value: string }): ToolResult {
  writePreference(input.key, input.value);
  return { status: "ok", key: input.key, value: input.value, message: `Preference "${input.key}" set to "${input.value}" - this will apply across all future chats, not just this one.` };
}

export function getPreference(input: { key: string }): ToolResult {
  const value = readPreference(input.key);
  if (value === undefined) return fail(`No preference set for "${input.key}".`);
  return { status: "ok", key: input.key, value };
}

export function listPreferences(): ToolResult {
  const rows = db.prepare("SELECT key, value FROM preferences ORDER BY key").all();
  return { status: "ok", preferences: rows };
}
