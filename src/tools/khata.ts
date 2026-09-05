import { db } from "../db/index.js";
import { fail, type ToolResult } from "./shared.js";

interface KhataCustomerRow {
  id: number;
  name: string;
  balance: number;
}

function findCustomer(name: string): KhataCustomerRow | undefined {
  return db.prepare("SELECT * FROM khata_customers WHERE name = ? COLLATE NOCASE").get(name.trim()) as KhataCustomerRow | undefined;
}

/** "Put ₹500 on Ramesh's credit" - creates the customer on first use (a kirana khata is opened by the act of extending credit). */
export function addKhataCredit(input: { chatId: string; customerName: string; amount: number; note?: string }): ToolResult {
  if (input.amount <= 0) return fail("Credit amount must be positive.");
  const name = input.customerName.trim();
  const tx = db.transaction(() => {
    let customer = findCustomer(name);
    if (!customer) {
      const info = db.prepare("INSERT INTO khata_customers (name, balance) VALUES (?, 0)").run(name);
      customer = { id: info.lastInsertRowid as number, name, balance: 0 };
    }
    db.prepare("UPDATE khata_customers SET balance = balance + ? WHERE id = ?").run(input.amount, customer.id);
    db.prepare("INSERT INTO khata_transactions (customer_id, type, amount, note, chat_id) VALUES (?, 'credit', ?, ?, ?)").run(
      customer.id, input.amount, input.note ?? null, input.chatId
    );
    return customer.id;
  });
  const customerId = tx();
  const updated = db.prepare("SELECT balance FROM khata_customers WHERE id = ?").get(customerId) as { balance: number };
  return { status: "ok", customer: name, newBalance: updated.balance, message: `₹${input.amount} added to ${name}'s khata. Balance now ₹${updated.balance}.` };
}

/**
 * "Ramesh paid ₹300" - guard: refuse to settle a khata that doesn't exist
 * (brief hard-part #7). If the payment would overpay the balance, this is
 * surfaced as `confirmation_required` rather than silently allowed or
 * silently refused - the model must confirm with the owner and re-call with
 * `confirm: true` before it's applied.
 */
export function recordKhataPayment(input: { chatId: string; customerName: string; amount: number; confirm?: boolean }): ToolResult {
  if (input.amount <= 0) return fail("Payment amount must be positive.");
  const customer = findCustomer(input.customerName);
  if (!customer) return fail(`No khata exists for "${input.customerName}" - nothing to settle. Refusing.`);

  if (input.amount > customer.balance && !input.confirm) {
    return {
      status: "confirmation_required",
      message: `${customer.name} only owes ₹${customer.balance}, but this payment is ₹${input.amount}. Confirm this is intentional (e.g. an advance) before recording it.`,
      details: { customer: customer.name, balance: customer.balance, requestedAmount: input.amount },
    };
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE khata_customers SET balance = balance - ? WHERE id = ?").run(input.amount, customer.id);
    db.prepare("INSERT INTO khata_transactions (customer_id, type, amount, chat_id) VALUES (?, 'payment', ?, ?)").run(customer.id, input.amount, input.chatId);
  });
  tx();
  const updated = db.prepare("SELECT balance FROM khata_customers WHERE id = ?").get(customer.id) as { balance: number };
  return { status: "ok", customer: customer.name, newBalance: updated.balance, message: `₹${input.amount} payment recorded for ${customer.name}. Balance now ₹${updated.balance}.` };
}

export function getKhataBalance(input: { customerName: string }): ToolResult {
  const customer = findCustomer(input.customerName);
  if (!customer) return fail(`No khata found for "${input.customerName}".`);
  const recent = db.prepare("SELECT type, amount, note, created_at FROM khata_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 10").all(customer.id);
  return { status: "ok", customer: customer.name, balance: customer.balance, recentTransactions: recent };
}

export function listKhataCustomers(): ToolResult {
  const rows = db.prepare("SELECT name, balance FROM khata_customers WHERE balance != 0 ORDER BY balance DESC").all();
  return { status: "ok", customers: rows };
}
