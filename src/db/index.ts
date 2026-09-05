import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/store.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema. Kept in one file so the "what does this store know" surface is
// auditable at a glance. Everything here survives process restarts (SQLite
// file on disk) - this is the durable memory the brief asks for: stock,
// khata, bills AND preferences outlive any single Telegram conversation.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  unit          TEXT NOT NULL,              -- kg | g | litre | ml | packet | dozen | piece
  cost_price    REAL NOT NULL,
  mrp           REAL NOT NULL,
  gst_rate      REAL NOT NULL,               -- percent, e.g. 5, 12, 18, 0
  hsn_code      TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','cancelled')),
  customer_name  TEXT,
  payment_mode   TEXT,                       -- cash | upi | card
  payment_ref    TEXT,
  subtotal       REAL NOT NULL DEFAULT 0,
  cgst           REAL NOT NULL DEFAULT 0,
  sgst           REAL NOT NULL DEFAULT 0,
  round_off      REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at   TEXT
);

CREATE TABLE IF NOT EXISTS bill_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  product_name    TEXT NOT NULL,             -- snapshot, survives product renames
  unit            TEXT NOT NULL,
  qty             REAL NOT NULL,
  unit_price      REAL NOT NULL,             -- MRP at time of billing
  gst_rate        REAL NOT NULL,
  line_subtotal   REAL NOT NULL,
  line_cgst       REAL NOT NULL,
  line_sgst       REAL NOT NULL,
  line_total      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS khata_customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  balance    REAL NOT NULL DEFAULT 0,        -- amount this customer owes the store
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS khata_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES khata_customers(id),
  type         TEXT NOT NULL CHECK (type IN ('credit','payment')),
  amount       REAL NOT NULL,
  note         TEXT,
  chat_id      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Standing preferences: default payment mode, preferred brand mappings,
-- shop name/GSTIN for invoices. Explicitly OUTSIDE the conversation window -
-- a /new chat clears message history (see conversation_messages) but never
-- touches this table.
CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram idempotency. Keyed on "chatId:messageId" - Telegram's stable
-- per-message identifier - so a redelivered update (Telegram retries on a
-- slow/failed ack) is detected and skipped here, before the agent, the model,
-- or any tool ever sees it a second time.
CREATE TABLE IF NOT EXISTS processed_updates (
  dedup_key    TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_closes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  close_date     TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD
  total_sales    REAL NOT NULL,
  tax_collected  REAL NOT NULL,
  cash_total     REAL NOT NULL,
  upi_total      REAL NOT NULL,
  card_total     REAL NOT NULL,
  bill_count     INTEGER NOT NULL,
  top_items_json TEXT NOT NULL,
  closed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-chat conversation transcript, persisted so the process can restart
-- without losing an in-progress conversation. /new truncates this per chat_id
-- but never touches products/khata/preferences - "memory lives outside the
-- context window, not just in it" per the brief.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                  -- user | assistant | tool
  content    TEXT NOT NULL,                  -- JSON-serialized AI SDK message part(s)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_state (
  chat_id        TEXT PRIMARY KEY,
  active_bill_id INTEGER,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_khata_tx_customer ON khata_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_conv_msgs_chat ON conversation_messages(chat_id, id);
`);

// ---------------------------------------------------------------------------
// Seed a realistic starter catalog matching the brief's example SKUs, so the
// agent has real grounded data to reason over on first run. Only runs once
// (guarded by row count) - never overwrites what an owner has since added.
// ---------------------------------------------------------------------------
const productCount = (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
if (productCount === 0) {
  const insert = db.prepare(`
    INSERT INTO products (name, unit, cost_price, mrp, gst_rate, hsn_code, qty, reorder_level)
    VALUES (@name, @unit, @cost_price, @mrp, @gst_rate, @hsn_code, @qty, @reorder_level)
  `);
  const seedProducts = [
    { name: "Aashirvaad Atta 5kg", unit: "packet", cost_price: 210, mrp: 245, gst_rate: 5, hsn_code: "1101", qty: 40, reorder_level: 10 },
    { name: "Loose Atta", unit: "kg", cost_price: 34, mrp: 40, gst_rate: 0, hsn_code: "1101", qty: 60, reorder_level: 15 },
    { name: "Tata Salt 1kg", unit: "packet", cost_price: 18, mrp: 22, gst_rate: 5, hsn_code: "2501", qty: 50, reorder_level: 10 },
    { name: "Amul Butter 100g", unit: "packet", cost_price: 48, mrp: 58, gst_rate: 12, hsn_code: "0405", qty: 30, reorder_level: 8 },
    { name: "Fortune Sunflower Oil 1L", unit: "packet", cost_price: 140, mrp: 165, gst_rate: 5, hsn_code: "1512", qty: 25, reorder_level: 6 },
    { name: "Maggi 70g", unit: "packet", cost_price: 12, mrp: 14, gst_rate: 12, hsn_code: "1902", qty: 6, reorder_level: 20 },
    { name: "Parle-G", unit: "packet", cost_price: 8, mrp: 10, gst_rate: 18, hsn_code: "1905", qty: 45, reorder_level: 15 },
    { name: "Surf Excel", unit: "packet", cost_price: 55, mrp: 65, gst_rate: 18, hsn_code: "3402", qty: 20, reorder_level: 5 },
    { name: "Loose Sugar", unit: "kg", cost_price: 40, mrp: 46, gst_rate: 5, hsn_code: "1701", qty: 55, reorder_level: 15 },
    { name: "Loose Rice", unit: "kg", cost_price: 42, mrp: 50, gst_rate: 0, hsn_code: "1006", qty: 70, reorder_level: 20 },
    { name: "Loose Toor Dal", unit: "kg", cost_price: 120, mrp: 140, gst_rate: 0, hsn_code: "0713", qty: 35, reorder_level: 10 },
  ];
  const insertMany = db.transaction((rows: typeof seedProducts) => {
    for (const r of rows) insert.run(r);
  });
  insertMany(seedProducts);
}

export function nowIso(): string {
  return new Date().toISOString();
}
