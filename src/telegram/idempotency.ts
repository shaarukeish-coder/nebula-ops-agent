import { db } from "../db/index.js";

/**
 * Returns true and records the key on first sight; returns false (already
 * seen) on any repeat. INSERT is the atomic check-and-set - two near-
 * simultaneous deliveries of the same message can't both pass.
 */
export function claimOnce(dedupKey: string): boolean {
  try {
    db.prepare("INSERT INTO processed_updates (dedup_key) VALUES (?)").run(dedupKey);
    return true;
  } catch {
    return false; // UNIQUE constraint hit - already processed
  }
}
