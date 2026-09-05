// GST maths, isolated from every caller. This is deliberate: the brief's
// hard-part #3 ("GST correctness") and #3-of-9 grounding rule both say tax
// logic must live in code the model calls, never something the model computes
// itself in free text. Every bill/invoice number in this app flows through
// these two functions.

export interface LineGst {
  lineSubtotal: number;
  lineCgst: number;
  lineSgst: number;
  lineTotal: number;
}

/** Round to the nearest paisa (2 decimals), half-up - standard invoice rounding. */
export function roundPaisa(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Intra-state GST split for one bill line. gstRate is the *total* slab
 * (e.g. 12 for 12%); CGST and SGST each take half, per the brief's domain
 * rule ("Intra-state = CGST + SGST split").
 */
export function computeLineGst(qty: number, unitPrice: number, gstRate: number): LineGst {
  const lineSubtotal = roundPaisa(qty * unitPrice);
  const totalGst = roundPaisa((lineSubtotal * gstRate) / 100);
  const lineCgst = roundPaisa(totalGst / 2);
  const lineSgst = roundPaisa(totalGst - lineCgst); // avoid losing a paisa to double rounding
  const lineTotal = roundPaisa(lineSubtotal + lineCgst + lineSgst);
  return { lineSubtotal, lineCgst, lineSgst, lineTotal };
}

export interface BillGstTotals {
  subtotal: number;
  cgst: number;
  sgst: number;
  roundOff: number;
  total: number;
}

/** Sums line totals and applies a single nearest-rupee round-off, shown as its own line - standard Indian retail invoice practice. */
export function computeBillTotals(lines: LineGst[]): BillGstTotals {
  const subtotal = roundPaisa(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const cgst = roundPaisa(lines.reduce((s, l) => s + l.lineCgst, 0));
  const sgst = roundPaisa(lines.reduce((s, l) => s + l.lineSgst, 0));
  const preRound = roundPaisa(subtotal + cgst + sgst);
  const total = Math.round(preRound);
  const roundOff = roundPaisa(total - preRound);
  return { subtotal, cgst, sgst, roundOff, total };
}
