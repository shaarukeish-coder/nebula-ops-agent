import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLineGst, computeBillTotals, roundPaisa } from "../src/gst/gst.js";

test("computeLineGst splits GST evenly into CGST/SGST", () => {
  const g = computeLineGst(2, 100, 12); // 2 units @ ₹100, 12% GST
  assert.equal(g.lineSubtotal, 200);
  assert.equal(g.lineCgst, 12); // 12% of 200 = 24, split -> 12/12
  assert.equal(g.lineSgst, 12);
  assert.equal(g.lineTotal, 224);
});

test("computeLineGst handles 0% slab (loose produce)", () => {
  const g = computeLineGst(3, 40, 0);
  assert.equal(g.lineCgst, 0);
  assert.equal(g.lineSgst, 0);
  assert.equal(g.lineTotal, 120);
});

test("computeLineGst never loses a paisa to double rounding on odd totals", () => {
  const g = computeLineGst(1, 33.33, 18); // deliberately awkward number
  assert.equal(roundPaisa(g.lineCgst + g.lineSgst + g.lineSubtotal), g.lineTotal);
});

test("computeBillTotals applies a single nearest-rupee round-off", () => {
  const lines = [computeLineGst(1, 14, 12), computeLineGst(2, 22, 5)];
  const totals = computeBillTotals(lines);
  assert.equal(Number.isInteger(totals.total), true);
  assert.equal(roundPaisa(totals.subtotal + totals.cgst + totals.sgst + totals.roundOff), totals.total);
});
