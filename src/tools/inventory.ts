import { db } from "../db/index.js";
import { findProductMatches, getProductById, clarify, fail, type ToolResult } from "./shared.js";

/** Add a brand-new SKU to the catalog. Refuses silent duplicates - re-adding an existing name is an error pointing at receiveStock instead. */
export function addProduct(input: {
  name: string;
  unit: string;
  costPrice: number;
  mrp: number;
  gstRate: number;
  hsnCode: string;
  reorderLevel?: number;
}): ToolResult {
  const existing = findProductMatches(input.name).find((p) => p.name.toLowerCase() === input.name.toLowerCase());
  if (existing) {
    return fail(`"${input.name}" already exists in the catalog (qty ${existing.qty}). Use receive-stock to add quantity, not add-product.`);
  }
  if (input.costPrice <= 0 || input.mrp <= 0) return fail("Cost price and MRP must be positive.");
  if (input.mrp < input.costPrice) return fail(`MRP (₹${input.mrp}) is below cost price (₹${input.costPrice}) - refusing, this would guarantee a loss on every sale. Confirm the numbers.`);
  const info = db
    .prepare(
      `INSERT INTO products (name, unit, cost_price, mrp, gst_rate, hsn_code, qty, reorder_level)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(input.name, input.unit, input.costPrice, input.mrp, input.gstRate, input.hsnCode, input.reorderLevel ?? 0);
  return { status: "ok", productId: info.lastInsertRowid, message: `Added "${input.name}" to the catalog with 0 stock. Receive stock next to make it sellable.` };
}

/** Stock-in event. Atomic increment - safe under concurrent receives. */
export function receiveStock(input: { productName: string; quantity: number; newCostPrice?: number }): ToolResult {
  if (input.quantity <= 0) return fail("Quantity received must be positive.");
  const matches = findProductMatches(input.productName);
  if (matches.length === 0) return fail(`No product matching "${input.productName}". Add it as a new product first (need unit, cost price, MRP, GST rate).`);
  if (matches.length > 1) return clarify(`Multiple products match "${input.productName}" - which one?`, matches.map((m) => ({ id: m.id, name: m.name, unit: m.unit, currentQty: m.qty })));
  const product = matches[0];
  const tx = db.transaction(() => {
    db.prepare("UPDATE products SET qty = qty + ?, updated_at = datetime('now') WHERE id = ?").run(input.quantity, product.id);
    if (input.newCostPrice !== undefined && input.newCostPrice > 0) {
      db.prepare("UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?").run(input.newCostPrice, product.id);
    }
  });
  tx();
  const updated = getProductById(product.id)!;
  return { status: "ok", product: updated.name, newQty: updated.qty, message: `${input.quantity} ${product.unit} of ${product.name} received. New stock: ${updated.qty} ${product.unit}.` };
}

export function getStock(input: { productName?: string }): ToolResult {
  if (!input.productName) {
    const all = db.prepare("SELECT name, unit, qty, reorder_level FROM products ORDER BY name").all();
    return { status: "ok", inventory: all };
  }
  const matches = findProductMatches(input.productName);
  if (matches.length === 0) return fail(`No product matching "${input.productName}".`);
  if (matches.length > 1) return clarify(`Multiple products match "${input.productName}" - which one?`, matches.map((m) => ({ id: m.id, name: m.name, qty: m.qty, unit: m.unit })));
  const p = matches[0];
  return { status: "ok", product: p.name, qty: p.qty, unit: p.unit, mrp: p.mrp, reorderLevel: p.reorder_level };
}

export function getLowStock(): ToolResult {
  const rows = db.prepare("SELECT name, unit, qty, reorder_level FROM products WHERE qty <= reorder_level ORDER BY qty ASC").all();
  return { status: "ok", lowStock: rows, count: rows.length };
}
