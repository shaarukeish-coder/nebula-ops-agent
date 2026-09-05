import { db } from "../db/index.js";
import { fail, type ToolResult } from "./shared.js";

// SQLite stores finalized_at as UTC ('now'). All grouping/reporting is done
// in IST (+5:30) since this is an Indian kirana store - a sale just after
// midnight IST must count for the new day, not the UTC day.
const IST_SHIFT = "'+5 hours', '+30 minutes'";

export function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

export function closeDay(input: { date?: string }): ToolResult {
  const dateStr = input.date ?? todayIST();

  const bills = db
    .prepare(`SELECT * FROM bills WHERE status = 'finalized' AND date(finalized_at, ${IST_SHIFT}) = ?`)
    .all(dateStr) as { id: number; total: number; cgst: number; sgst: number; payment_mode: string }[];

  if (bills.length === 0) {
    return { status: "ok", date: dateStr, billCount: 0, totalSales: 0, taxCollected: 0, message: `No finalized bills for ${dateStr}.` };
  }

  const totalSales = bills.reduce((s, b) => s + b.total, 0);
  const taxCollected = bills.reduce((s, b) => s + b.cgst + b.sgst, 0);
  const cashTotal = bills.filter((b) => b.payment_mode === "cash").reduce((s, b) => s + b.total, 0);
  const upiTotal = bills.filter((b) => b.payment_mode === "upi").reduce((s, b) => s + b.total, 0);
  const cardTotal = bills.filter((b) => b.payment_mode === "card").reduce((s, b) => s + b.total, 0);

  const billIds = bills.map((b) => b.id);
  const placeholders = billIds.map(() => "?").join(",");
  const topItems = db
    .prepare(
      `SELECT product_name, SUM(qty) as totalQty, SUM(line_total) as revenue
       FROM bill_items WHERE bill_id IN (${placeholders})
       GROUP BY product_name ORDER BY revenue DESC LIMIT 5`
    )
    .all(...billIds) as { product_name: string; totalQty: number; revenue: number }[];

  db.prepare(
    `INSERT INTO daily_closes (close_date, total_sales, tax_collected, cash_total, upi_total, card_total, bill_count, top_items_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(close_date) DO UPDATE SET total_sales=excluded.total_sales, tax_collected=excluded.tax_collected,
       cash_total=excluded.cash_total, upi_total=excluded.upi_total, card_total=excluded.card_total,
       bill_count=excluded.bill_count, top_items_json=excluded.top_items_json, closed_at=datetime('now')`
  ).run(dateStr, totalSales, taxCollected, cashTotal, upiTotal, cardTotal, bills.length, JSON.stringify(topItems));

  return {
    status: "ok",
    date: dateStr,
    billCount: bills.length,
    totalSales,
    taxCollected,
    cashTotal,
    upiTotal,
    cardTotal,
    topItems,
    message: `Day closed for ${dateStr}: ${bills.length} bills, ₹${totalSales} total sales, ₹${taxCollected} tax collected.`,
  };
}

export interface SalesAnalysis {
  periodDays: number;
  billCount: number;
  dailySales: { date: string; total: number }[];
  topItems: { name: string; qty: number; revenue: number }[];
  paymentMix: { cash: number; upi: number; card: number };
  gstCollected: number;
  totalSales: number;
  stockValue: number;
  lowStock: { name: string; qty: number; unit: string; reorder_level: number }[];
}

/** Backing data for the PPTX analysis deck. Pure aggregation over real finalized bills - no synthetic numbers. */
export function getSalesAnalysis(periodDays: number): SalesAnalysis {
  const bills = db
    .prepare(
      `SELECT * FROM bills WHERE status = 'finalized' AND date(finalized_at, ${IST_SHIFT}) >= date('now', ${IST_SHIFT}, '-${periodDays} days')`
    )
    .all() as { id: number; total: number; cgst: number; sgst: number; payment_mode: string; finalized_at: string }[];

  const byDate = new Map<string, number>();
  for (const b of bills) {
    const d = db.prepare(`SELECT date(?, ${IST_SHIFT}) as d`).get(b.finalized_at) as { d: string };
    byDate.set(d.d, (byDate.get(d.d) ?? 0) + b.total);
  }
  const dailySales = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, total]) => ({ date, total }));

  const billIds = bills.map((b) => b.id);
  let topItems: { name: string; qty: number; revenue: number }[] = [];
  if (billIds.length > 0) {
    const placeholders = billIds.map(() => "?").join(",");
    topItems = (
      db
        .prepare(
          `SELECT product_name as name, SUM(qty) as qty, SUM(line_total) as revenue
           FROM bill_items WHERE bill_id IN (${placeholders}) GROUP BY product_name ORDER BY revenue DESC LIMIT 8`
        )
        .all(...billIds) as { name: string; qty: number; revenue: number }[]
    );
  }

  const paymentMix = {
    cash: bills.filter((b) => b.payment_mode === "cash").reduce((s, b) => s + b.total, 0),
    upi: bills.filter((b) => b.payment_mode === "upi").reduce((s, b) => s + b.total, 0),
    card: bills.filter((b) => b.payment_mode === "card").reduce((s, b) => s + b.total, 0),
  };
  const gstCollected = bills.reduce((s, b) => s + b.cgst + b.sgst, 0);
  const totalSales = bills.reduce((s, b) => s + b.total, 0);

  const stockRow = db.prepare("SELECT SUM(qty * cost_price) as v FROM products").get() as { v: number | null };
  const lowStock = db
    .prepare("SELECT name, qty, unit, reorder_level FROM products WHERE qty <= reorder_level ORDER BY qty ASC")
    .all() as { name: string; qty: number; unit: string; reorder_level: number }[];

  return { periodDays, billCount: bills.length, dailySales, topItems, paymentMix, gstCollected, totalSales, stockValue: stockRow.v ?? 0, lowStock };
}
