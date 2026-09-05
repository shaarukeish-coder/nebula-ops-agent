import fs from "node:fs";
import path from "node:path";
import pptxgenjsModule from "pptxgenjs";
import { getSalesAnalysis, todayIST } from "../tools/analytics.js";
import { readPreference } from "../tools/preferences.js";
import type { ToolResult } from "../tools/shared.js";

// pptxgenjs's shipped .d.ts doesn't line up cleanly with NodeNext ESM
// resolution (it types as a namespace, not a constructable class), even
// though the runtime export is a plain class. Cast once here rather than
// fight the declaration file - everything below is exercised at runtime
// the normal way, this only affects compile-time typing.
const PptxGenJS = pptxgenjsModule as unknown as new () => any;

const DECK_DIR = "./data/decks";
fs.mkdirSync(DECK_DIR, { recursive: true });

const BRAND = "363B4A";
const ACCENT = "C0392B";

/**
 * Business-analysis deck built from the agent's own aggregation tool
 * (getSalesAnalysis), rendered with pptxgenjs's native chart objects - real
 * charts a reviewer can click into, not a screenshot pasted onto a slide
 * (brief hard-part #8).
 */
export async function generateAnalysisDeck(input: { periodDays?: number }): Promise<ToolResult> {
  const periodDays = input.periodDays ?? 7;
  const data = getSalesAnalysis(periodDays);
  const shopName = readPreference("shop_name") ?? "Nebula Kirana Store";

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 10, height: 5.63 });
  pptx.layout = "WIDE";

  // --- Title slide ---
  let slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addText(shopName, { x: 0.5, y: 1.7, w: 9, h: 0.8, fontSize: 32, bold: true, color: BRAND });
  slide.addText(`Sales Analysis - Last ${periodDays} Days`, { x: 0.5, y: 2.4, w: 9, h: 0.6, fontSize: 18, color: ACCENT });
  slide.addText(`Generated ${todayIST()}`, { x: 0.5, y: 3.0, w: 9, h: 0.4, fontSize: 11, color: "888888" });

  // --- KPI slide ---
  slide = pptx.addSlide();
  slide.addText("Key Numbers", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: BRAND });
  const kpis: [string, string][] = [
    ["Total Sales", `₹${data.totalSales.toFixed(0)}`],
    ["Bills Finalized", `${data.billCount}`],
    ["GST Collected", `₹${data.gstCollected.toFixed(0)}`],
    ["Stock Value (cost)", `₹${data.stockValue.toFixed(0)}`],
  ];
  kpis.forEach(([label, value], i) => {
    const x = 0.5 + (i % 2) * 4.7;
    const y = 1.2 + Math.floor(i / 2) * 1.7;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 4.3, h: 1.4, fill: { color: "F5F5F5" }, line: { color: "DDDDDD" } });
    slide.addText(value, { x, y: y + 0.15, w: 4.3, align: "center", fontSize: 26, bold: true, color: ACCENT });
    slide.addText(label, { x, y: y + 0.85, w: 4.3, align: "center", fontSize: 12, color: "555555" });
  });

  // --- Daily sales trend ---
  if (data.dailySales.length > 0) {
    slide = pptx.addSlide();
    slide.addText("Daily Sales Trend", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: BRAND });
    slide.addChart(
      pptx.ChartType.bar,
      [{ name: "Sales (₹)", labels: data.dailySales.map((d) => d.date.slice(5)), values: data.dailySales.map((d) => d.total) }],
      { x: 0.5, y: 1.0, w: 9, h: 4.3, chartColors: [ACCENT], showValue: true, valAxisTitle: "₹" }
    );
  }

  // --- Top items ---
  if (data.topItems.length > 0) {
    slide = pptx.addSlide();
    slide.addText("Top Items by Revenue", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: BRAND });
    slide.addChart(
      pptx.ChartType.bar,
      [{ name: "Revenue (₹)", labels: data.topItems.map((t) => t.name), values: data.topItems.map((t) => Math.round(t.revenue)) }],
      { x: 0.5, y: 1.0, w: 9, h: 4.3, barDir: "bar", chartColors: [BRAND], showValue: true }
    );
  }

  // --- Payment mix ---
  const mixTotal = data.paymentMix.cash + data.paymentMix.upi + data.paymentMix.card;
  if (mixTotal > 0) {
    slide = pptx.addSlide();
    slide.addText("Payment Mix", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: BRAND });
    slide.addChart(
      pptx.ChartType.pie,
      [{ name: "Payment Mode", labels: ["Cash", "UPI", "Card"], values: [data.paymentMix.cash, data.paymentMix.upi, data.paymentMix.card] }],
      { x: 1.5, y: 1.0, w: 7, h: 4.3, showLegend: true, legendPos: "b", chartColors: [ACCENT, BRAND, "7F8C8D"], showPercent: true }
    );
  }

  // --- Stock health ---
  slide = pptx.addSlide();
  slide.addText("Stock Health", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: BRAND });
  if (data.lowStock.length === 0) {
    slide.addText("All SKUs are above their reorder level.", { x: 0.5, y: 1.3, fontSize: 14, color: "27AE60" });
  } else {
    const rows: any[] = [
      [
        { text: "Product", options: { bold: true, fill: { color: "F0F0F0" } } },
        { text: "In stock", options: { bold: true, fill: { color: "F0F0F0" } } },
        { text: "Reorder level", options: { bold: true, fill: { color: "F0F0F0" } } },
      ],
      ...data.lowStock.map((p) => [
        { text: p.name },
        { text: `${p.qty} ${p.unit}` },
        { text: `${p.reorder_level} ${p.unit}` },
      ]),
    ];
    slide.addTable(rows, { x: 0.5, y: 1.0, w: 9, fontSize: 11, autoPage: true });
  }

  const filePath = path.join(DECK_DIR, `analysis-${Date.now()}.pptx`);
  await pptx.writeFile({ fileName: filePath });

  return { status: "ok", filePath, periodDays, totalSales: data.totalSales, message: `Analysis deck for the last ${periodDays} days generated.` };
}
