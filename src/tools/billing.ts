import { db } from "../db/index.js";
import { findProductMatches, getProductById, clarify, fail, type ToolResult } from "./shared.js";
import { computeLineGst, computeBillTotals } from "../gst/gst.js";
import { readPreference } from "./preferences.js";

export interface BillItemRow {
  id: number;
  bill_id: number;
  product_id: number;
  product_name: string;
  unit: string;
  qty: number;
  unit_price: number;
  gst_rate: number;
  line_subtotal: number;
  line_cgst: number;
  line_sgst: number;
  line_total: number;
}

export interface BillRow {
  id: number;
  chat_id: string;
  status: "draft" | "finalized" | "cancelled";
  customer_name: string | null;
  payment_mode: string | null;
  payment_ref: string | null;
  subtotal: number;
  cgst: number;
  sgst: number;
  round_off: number;
  total: number;
  created_at: string;
  finalized_at: string | null;
}

function getActiveBillId(chatId: string): number | undefined {
  const row = db.prepare("SELECT active_bill_id FROM conversation_state WHERE chat_id = ?").get(chatId) as
    | { active_bill_id: number | null }
    | undefined;
  return row?.active_bill_id ?? undefined;
}

function setActiveBillId(chatId: string, billId: number | null) {
  db.prepare(
    `INSERT INTO conversation_state (chat_id, active_bill_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET active_bill_id = excluded.active_bill_id, updated_at = datetime('now')`
  ).run(chatId, billId);
}

/** Reuses the chat's open draft bill if one exists; otherwise starts a new one. One open bill per chat by design - matches "a bill builds over several messages" (brief hard-part #4). */
export function getOrCreateDraftBill(chatId: string, customerName?: string): BillRow {
  const activeId = getActiveBillId(chatId);
  if (activeId) {
    const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(activeId) as BillRow | undefined;
    if (bill && bill.status === "draft") return bill;
  }
  const info = db.prepare("INSERT INTO bills (chat_id, customer_name) VALUES (?, ?)").run(chatId, customerName ?? null);
  setActiveBillId(chatId, info.lastInsertRowid as number);
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(info.lastInsertRowid) as BillRow;
}

function recomputeAndStoreBillTotals(billId: number) {
  const items = db.prepare("SELECT * FROM bill_items WHERE bill_id = ?").all(billId) as BillItemRow[];
  const totals = computeBillTotals(items.map((i) => ({ lineSubtotal: i.line_subtotal, lineCgst: i.line_cgst, lineSgst: i.line_sgst, lineTotal: i.line_total })));
  db.prepare("UPDATE bills SET subtotal = ?, cgst = ?, sgst = ?, round_off = ?, total = ? WHERE id = ?").run(
    totals.subtotal, totals.cgst, totals.sgst, totals.roundOff, totals.total, billId
  );
  return totals;
}

export function startBill(input: { chatId: string; customerName?: string }): ToolResult {
  const bill = getOrCreateDraftBill(input.chatId, input.customerName);
  return { status: "ok", billId: bill.id, message: `Bill #${bill.id} started. Add items one at a time or all at once.` };
}

/** Adds qty of a product to the chat's draft bill. Grounding: unit_price and gst_rate are read from the products table, never invented (hard-part #1). Oversell guard: soft check here (fast feedback); the authoritative atomic check is in finalizeBill (hard-part #2 - enforced where the data changes, not here). */
export function addBillItem(input: { chatId: string; productName: string; quantity: number }): ToolResult {
  if (input.quantity <= 0) return fail("Quantity must be positive.");
  const matches = findProductMatches(input.productName);
  if (matches.length === 0) return fail(`No product matching "${input.productName}" in the catalog.`);
  if (matches.length > 1) {
    return clarify(`Multiple products match "${input.productName}" - which one?`, matches.map((m) => ({ id: m.id, name: m.name, unit: m.unit })));
  }
  const product = matches[0];
  const bill = getOrCreateDraftBill(input.chatId);

  const existingLine = db.prepare("SELECT * FROM bill_items WHERE bill_id = ? AND product_id = ?").get(bill.id, product.id) as BillItemRow | undefined;
  const requestedTotalQty = (existingLine?.qty ?? 0) + input.quantity;

  if (requestedTotalQty > product.qty) {
    return fail(`Can't add ${input.quantity} ${product.unit} of ${product.name} - only ${product.qty} ${product.unit} in stock (bill would need ${requestedTotalQty}).`);
  }

  const gst = computeLineGst(requestedTotalQty, product.mrp, product.gst_rate);
  const tx = db.transaction(() => {
    if (existingLine) {
      db.prepare(
        "UPDATE bill_items SET qty = ?, line_subtotal = ?, line_cgst = ?, line_sgst = ? , line_total = ? WHERE id = ?"
      ).run(requestedTotalQty, gst.lineSubtotal, gst.lineCgst, gst.lineSgst, gst.lineTotal, existingLine.id);
    } else {
      db.prepare(
        `INSERT INTO bill_items (bill_id, product_id, product_name, unit, qty, unit_price, gst_rate, line_subtotal, line_cgst, line_sgst, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(bill.id, product.id, product.name, product.unit, requestedTotalQty, product.mrp, product.gst_rate, gst.lineSubtotal, gst.lineCgst, gst.lineSgst, gst.lineTotal);
    }
    recomputeAndStoreBillTotals(bill.id);
  });
  tx();
  return { status: "ok", billId: bill.id, product: product.name, lineQty: requestedTotalQty, message: `${product.name} x ${requestedTotalQty} ${product.unit} added.` };
}

/** Sets a line to an absolute quantity (covers "make it 6 Maggi"). quantity 0 removes the line. */
export function setBillItemQuantity(input: { chatId: string; productName: string; quantity: number }): ToolResult {
  const bill = getOrCreateDraftBill(input.chatId);
  const matches = findProductMatches(input.productName);
  if (matches.length === 0) return fail(`No product matching "${input.productName}".`);
  if (matches.length > 1) return clarify(`Multiple products match "${input.productName}" - which one?`, matches.map((m) => ({ id: m.id, name: m.name })));
  const product = matches[0];
  if (input.quantity < 0) return fail("Quantity can't be negative.");
  if (input.quantity > product.qty) return fail(`Can't set ${product.name} to ${input.quantity} ${product.unit} - only ${product.qty} in stock.`);

  const existingLine = db.prepare("SELECT * FROM bill_items WHERE bill_id = ? AND product_id = ?").get(bill.id, product.id) as BillItemRow | undefined;
  const tx = db.transaction(() => {
    if (input.quantity === 0) {
      if (existingLine) db.prepare("DELETE FROM bill_items WHERE id = ?").run(existingLine.id);
    } else {
      const gst = computeLineGst(input.quantity, product.mrp, product.gst_rate);
      if (existingLine) {
        db.prepare("UPDATE bill_items SET qty=?, line_subtotal=?, line_cgst=?, line_sgst=?, line_total=? WHERE id=?").run(
          input.quantity, gst.lineSubtotal, gst.lineCgst, gst.lineSgst, gst.lineTotal, existingLine.id
        );
      } else {
        db.prepare(
          `INSERT INTO bill_items (bill_id, product_id, product_name, unit, qty, unit_price, gst_rate, line_subtotal, line_cgst, line_sgst, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(bill.id, product.id, product.name, product.unit, input.quantity, product.mrp, product.gst_rate, gst.lineSubtotal, gst.lineCgst, gst.lineSgst, gst.lineTotal);
      }
    }
    recomputeAndStoreBillTotals(bill.id);
  });
  tx();
  return { status: "ok", billId: bill.id, product: product.name, newQty: input.quantity };
}

export function removeBillItem(input: { chatId: string; productName: string }): ToolResult {
  const bill = getOrCreateDraftBill(input.chatId);
  const matches = findProductMatches(input.productName);
  if (matches.length === 0) return fail(`No product matching "${input.productName}".`);
  const product = matches[0];
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM bill_items WHERE bill_id = ? AND product_id = ?").run(bill.id, product.id);
    recomputeAndStoreBillTotals(bill.id);
  });
  tx();
  return { status: "ok", billId: bill.id, message: `Removed ${product.name} from bill #${bill.id}.` };
}

export function setBillPaymentMode(input: { chatId: string; mode: "cash" | "upi" | "card"; reference?: string }): ToolResult {
  const bill = getOrCreateDraftBill(input.chatId);
  db.prepare("UPDATE bills SET payment_mode = ?, payment_ref = ? WHERE id = ?").run(input.mode, input.reference ?? null, bill.id);
  return { status: "ok", billId: bill.id, paymentMode: input.mode };
}

export function viewBill(input: { chatId: string }): ToolResult {
  const bill = getOrCreateDraftBill(input.chatId);
  const items = db.prepare("SELECT product_name, unit, qty, unit_price, gst_rate, line_total FROM bill_items WHERE bill_id = ?").all(bill.id);
  return { status: "ok", billId: bill.id, status_of_bill: bill.status, items, subtotal: bill.subtotal, cgst: bill.cgst, sgst: bill.sgst, roundOff: bill.round_off, total: bill.total };
}

/**
 * The authoritative money-and-stock moment. Everything else is soft; this is
 * hard. Two guarantees enforced here, both at the DB layer (brief section 5:
 * "business rules live in skills/tools... where the data changes"):
 *  - Oversell guard: each line decrements stock via UPDATE...WHERE qty>=?,
 *    so a race between two simultaneous finalizes on the same product can't
 *    push qty negative - one of them will see changes=0 and be rejected.
 *  - Idempotency: if the bill is already finalized, this is a no-op that
 *    returns the existing result rather than double-decrementing stock. This
 *    covers both a Telegram-redelivered "finalize" message and any accidental
 *    duplicate tool call from the model.
 * The whole stock-decrement loop runs inside one better-sqlite3 transaction,
 * which executes synchronously - no other handler in this single-threaded
 * Node process can interleave a second bill's stock changes mid-transaction,
 * which is what keeps two concurrent bills for the same SKU from corrupting
 * stock (brief hard-part #6).
 */
export function finalizeBill(input: { chatId: string; paymentMode?: "cash" | "upi" | "card"; paymentRef?: string }): ToolResult {
  const activeId = getActiveBillId(input.chatId);
  if (!activeId) return fail("No bill in progress for this chat. Start one first.");
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(activeId) as BillRow;

  if (bill.status === "finalized") {
    const items = db.prepare("SELECT product_name, qty, unit, line_total FROM bill_items WHERE bill_id = ?").all(bill.id);
    return { status: "ok", billId: bill.id, alreadyFinalized: true, items, total: bill.total, message: `Bill #${bill.id} was already finalized - not billing again.` };
  }
  if (bill.status === "cancelled") return fail(`Bill #${bill.id} was cancelled.`);

  const items = db.prepare("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as BillItemRow[];
  if (items.length === 0) return fail("Bill has no items - add at least one before finalizing.");

  const paymentMode = input.paymentMode ?? (bill.payment_mode as "cash" | "upi" | "card" | null) ?? readPreference("default_payment_mode");
  if (!paymentMode) {
    return clarify("What's the payment mode for this bill - cash, UPI, or card?", []);
  }

  type Shortfall = { product: string; requested: number; available: number };
  let shortfalls: Shortfall[] = [];

  try {
    const tx = db.transaction(() => {
      for (const item of items) {
        const result = db.prepare("UPDATE products SET qty = qty - ?, updated_at = datetime('now') WHERE id = ? AND qty >= ?").run(item.qty, item.product_id, item.qty);
        if (result.changes === 0) {
          const current = getProductById(item.product_id);
          shortfalls.push({ product: item.product_name, requested: item.qty, available: current?.qty ?? 0 });
        }
      }
      if (shortfalls.length > 0) {
        throw new Error("OVERSELL_GUARD");
      }
      const totals = recomputeAndStoreBillTotals(bill.id);
      db.prepare(
        "UPDATE bills SET status = 'finalized', payment_mode = ?, payment_ref = ?, finalized_at = datetime('now') WHERE id = ?"
      ).run(paymentMode, input.paymentRef ?? bill.payment_ref ?? null, bill.id);
      return totals;
    });
    const totals = tx();
    // Deliberately NOT clearing conversation_state.active_bill_id here: a
    // retried "finalize" (Telegram redelivery, or a duplicate model tool
    // call) must still be able to find this bill via getActiveBillId and
    // hit the alreadyFinalized branch above, not "no bill in progress".
    // getOrCreateDraftBill already starts a fresh bill next time this chat
    // adds an item, since it checks status === 'draft' before reusing one.
    const finalItems = db.prepare("SELECT product_name, qty, unit, line_total FROM bill_items WHERE bill_id = ?").all(bill.id);
    return {
      status: "ok",
      billId: bill.id,
      items: finalItems,
      subtotal: totals.subtotal,
      cgst: totals.cgst,
      sgst: totals.sgst,
      roundOff: totals.roundOff,
      total: totals.total,
      paymentMode,
      message: `Bill #${bill.id} finalized. Total ₹${totals.total} (${paymentMode}). Stock updated.`,
    };
  } catch (e) {
    if (shortfalls.length > 0) {
      const detail = shortfalls.map((s) => `${s.product}: asked ${s.requested}, only ${s.available} left`).join("; ");
      return fail(`Can't finalize bill #${bill.id} - stock changed underneath it: ${detail}. Adjust quantities and try again.`);
    }
    throw e;
  }
}

export function getLatestBillForChat(chatId: string, statusFilter?: "draft" | "finalized"): BillRow | undefined {
  const q = statusFilter
    ? db.prepare("SELECT * FROM bills WHERE chat_id = ? AND status = ? ORDER BY id DESC LIMIT 1")
    : db.prepare("SELECT * FROM bills WHERE chat_id = ? ORDER BY id DESC LIMIT 1");
  return (statusFilter ? q.get(chatId, statusFilter) : q.get(chatId)) as BillRow | undefined;
}

export function getBillById(billId: number): BillRow | undefined {
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(billId) as BillRow | undefined;
}

export function getBillItems(billId: number): BillItemRow[] {
  return db.prepare("SELECT * FROM bill_items WHERE bill_id = ?").all(billId) as BillItemRow[];
}
