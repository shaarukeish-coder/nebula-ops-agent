// Exercises the oversell guard and finalize idempotency directly against a
// throwaway SQLite file - no Telegram or LLM involved, so it runs in CI with
// zero external dependencies beyond the DB layer itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DB_PATH = "./data/test-oversell.db";
fs.rmSync(process.env.DB_PATH, { force: true });

const { addBillItem, finalizeBill, getOrCreateDraftBill } = await import("../src/tools/billing.js");
const { db } = await import("../src/db/index.js");

test("cannot add more to a bill than is in stock", () => {
  const chatId = "test-chat-1";
  const product = db.prepare("SELECT * FROM products WHERE name = 'Maggi 70g'").get() as { qty: number };
  const r = addBillItem({ chatId, productName: "Maggi 70g", quantity: product.qty + 1000 });
  assert.equal(r.status, "error");
});

test("finalize decrements stock exactly once and is idempotent on retry", () => {
  const chatId = "test-chat-2";
  const before = db.prepare("SELECT qty FROM products WHERE name = 'Loose Sugar'").get() as { qty: number };
  getOrCreateDraftBill(chatId);
  addBillItem({ chatId, productName: "Loose Sugar", quantity: 2 });

  const first = finalizeBill({ chatId, paymentMode: "cash" });
  assert.equal(first.status, "ok");
  const afterFirst = db.prepare("SELECT qty FROM products WHERE name = 'Loose Sugar'").get() as { qty: number };
  assert.equal(afterFirst.qty, before.qty - 2);

  // Simulate a redelivered "finalize" - must NOT decrement again.
  const second = finalizeBill({ chatId, paymentMode: "cash" });
  assert.equal(second.status, "ok");
  assert.equal((second as { alreadyFinalized?: boolean }).alreadyFinalized, true);
  const afterSecond = db.prepare("SELECT qty FROM products WHERE name = 'Loose Sugar'").get() as { qty: number };
  assert.equal(afterSecond.qty, before.qty - 2, "stock must not decrement twice");
});
