import type { ModelMessage } from "ai";
import { db } from "../db/index.js";

/**
 * Conversation transcript, persisted in SQLite per chat_id. This is what
 * /new clears - and ONLY this. Products, bills, khata and preferences all
 * live in other tables untouched by this function, which is what makes
 * "memory lives outside the context window, not just in it" true rather than
 * just asserted.
 */
export function loadMessages(chatId: string): ModelMessage[] {
  const rows = db.prepare("SELECT content FROM conversation_messages WHERE chat_id = ? ORDER BY id ASC").all(chatId) as { content: string }[];
  return rows.map((r) => JSON.parse(r.content) as ModelMessage);
}

export function appendMessages(chatId: string, messages: ModelMessage[]) {
  const insert = db.prepare("INSERT INTO conversation_messages (chat_id, role, content) VALUES (?, ?, ?)");
  const tx = db.transaction((msgs: ModelMessage[]) => {
    for (const m of msgs) insert.run(chatId, m.role, JSON.stringify(m));
  });
  tx(messages);
}

export function clearMessages(chatId: string) {
  db.prepare("DELETE FROM conversation_messages WHERE chat_id = ?").run(chatId);
}
