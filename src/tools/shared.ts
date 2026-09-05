import { db } from "../db/index.js";

export interface ProductRow {
  id: number;
  name: string;
  unit: string;
  cost_price: number;
  mrp: number;
  gst_rate: number;
  hsn_code: string;
  qty: number;
  reorder_level: number;
}

/**
 * Fuzzy product lookup by name. Returns ranked candidates - exact match
 * first, then prefix, then substring. Callers (tools) decide what to do with
 * 0, 1, or >1 matches; this function never guesses on the caller's behalf.
 * This is the mechanism behind "ask a clarifying question rather than guess"
 * (brief section 3): the tool surfaces the ambiguity as data, the model
 * decides whether/how to ask.
 */
export function findProductMatches(query: string): ProductRow[] {
  const q = query.trim().toLowerCase();
  const all = db.prepare("SELECT * FROM products").all() as ProductRow[];
  const exact = all.filter((p) => p.name.toLowerCase() === q);
  if (exact.length) return exact;
  const starts = all.filter((p) => p.name.toLowerCase().startsWith(q));
  if (starts.length) return starts;
  return all.filter((p) => p.name.toLowerCase().includes(q));
}

export function getProductById(id: number): ProductRow | undefined {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
}

/** Standard shape every tool resolves to. Keeps the model's job simple: read `status`, act accordingly. */
export type ToolResult<T = Record<string, unknown>> =
  | ({ status: "ok" } & T)
  | { status: "needs_clarification"; message: string; candidates: unknown[] }
  | { status: "confirmation_required"; message: string; details: Record<string, unknown> }
  | { status: "error"; message: string };

export function clarify(message: string, candidates: unknown[]): ToolResult {
  return { status: "needs_clarification", message, candidates };
}

export function fail(message: string): ToolResult {
  return { status: "error", message };
}
