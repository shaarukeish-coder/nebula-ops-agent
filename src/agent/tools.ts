import { tool } from "ai";
import { z } from "zod";
import * as inventory from "../tools/inventory.js";
import * as billing from "../tools/billing.js";
import * as khata from "../tools/khata.js";
import * as preferences from "../tools/preferences.js";
import * as analytics from "../tools/analytics.js";
import { generateInvoicePdf } from "../docs/invoice.js";
import { generateAnalysisDeck } from "../docs/deck.js";

const paymentMode = z.enum(["cash", "upi", "card"]);

/**
 * One factory, bound to a single Telegram chat. The chat_id is plumbing the
 * *model* never sees or reasons about - it's injected here so each tool call
 * automatically operates on the right owner's bill/conversation, the same
 * way a real POS would scope every action to the till that's open.
 */
export function createToolsForChat(chatId: string) {
  return {
    "add-product": tool({
      description: "Add a brand-new SKU to the catalog. Refuses if the name already exists (use receive-stock instead).",
      inputSchema: z.object({
        name: z.string(),
        unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
        costPrice: z.number().positive(),
        mrp: z.number().positive(),
        gstRate: z.number().min(0).max(28),
        hsnCode: z.string(),
        reorderLevel: z.number().min(0).optional(),
      }),
      execute: async (args) => inventory.addProduct(args),
    }),

    "receive-stock": tool({
      description: "Record stock coming into the store for an existing product. Increments quantity atomically.",
      inputSchema: z.object({
        productName: z.string(),
        quantity: z.number().positive(),
        newCostPrice: z.number().positive().optional().describe("If this batch came in at a different cost price"),
      }),
      execute: async (args) => inventory.receiveStock(args),
    }),

    "get-stock": tool({
      description: "Check stock for one product, or list the whole inventory if productName is omitted.",
      inputSchema: z.object({ productName: z.string().optional() }),
      execute: async (args) => inventory.getStock(args),
    }),

    "get-low-stock": tool({
      description: "List products at or below their reorder level.",
      inputSchema: z.object({}),
      execute: async () => inventory.getLowStock(),
    }),

    "start-bill": tool({
      description: "Start (or resume) the draft bill for this chat.",
      inputSchema: z.object({ customerName: z.string().optional() }),
      execute: async (args) => billing.startBill({ chatId, ...args }),
    }),

    "add-bill-item": tool({
      description: "Add a quantity of a product to the current draft bill. If the product is already on the bill, this ADDS to the existing line quantity.",
      inputSchema: z.object({ productName: z.string(), quantity: z.number().positive() }),
      execute: async (args) => billing.addBillItem({ chatId, ...args }),
    }),

    "set-bill-item-quantity": tool({
      description: "Set a bill line to an EXACT quantity (e.g. 'make it 6 Maggi'). Quantity 0 removes the line.",
      inputSchema: z.object({ productName: z.string(), quantity: z.number().min(0) }),
      execute: async (args) => billing.setBillItemQuantity({ chatId, ...args }),
    }),

    "remove-bill-item": tool({
      description: "Remove a product entirely from the current draft bill (e.g. 'drop the butter').",
      inputSchema: z.object({ productName: z.string() }),
      execute: async (args) => billing.removeBillItem({ chatId, ...args }),
    }),

    "set-bill-payment-mode": tool({
      description: "Set the payment mode (cash/upi/card) for the current draft bill.",
      inputSchema: z.object({ mode: paymentMode, reference: z.string().optional().describe("UPI ref / card last 4, if given") }),
      execute: async (args) => billing.setBillPaymentMode({ chatId, ...args }),
    }),

    "view-bill": tool({
      description: "Show the current draft bill's items and running totals.",
      inputSchema: z.object({}),
      execute: async () => billing.viewBill({ chatId }),
    }),

    "finalize-bill": tool({
      description: "Finalize the current draft bill: locks in GST totals, decrements stock, requires a payment mode. Safe to call again on an already-finalized bill (no-op, won't double-bill).",
      inputSchema: z.object({ paymentMode: paymentMode.optional(), paymentRef: z.string().optional() }),
      execute: async (args) => billing.finalizeBill({ chatId, ...args }),
    }),

    "add-khata-credit": tool({
      description: "Put an amount on a customer's khata (credit ledger). Creates the customer if new.",
      inputSchema: z.object({ customerName: z.string(), amount: z.number().positive(), note: z.string().optional() }),
      execute: async (args) => khata.addKhataCredit({ chatId, ...args }),
    }),

    "record-khata-payment": tool({
      description: "Record a payment from a customer against their khata balance. Refuses if the customer has no khata. If the payment exceeds their balance, returns confirmation_required first - re-call with confirm:true after the owner confirms.",
      inputSchema: z.object({ customerName: z.string(), amount: z.number().positive(), confirm: z.boolean().optional() }),
      execute: async (args) => khata.recordKhataPayment({ chatId, ...args }),
    }),

    "get-khata-balance": tool({
      description: "Check a customer's khata balance and recent transactions.",
      inputSchema: z.object({ customerName: z.string() }),
      execute: async (args) => khata.getKhataBalance(args),
    }),

    "list-khata-customers": tool({
      description: "List all customers with a non-zero khata balance.",
      inputSchema: z.object({}),
      execute: async () => khata.listKhataCustomers(),
    }),

    "set-preference": tool({
      description: "Set a standing store preference (e.g. key='default_payment_mode' value='upi', key='shop_name' value='...', key='shop_gstin' value='...'). Persists across all future chats.",
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      execute: async (args) => preferences.setPreference(args),
    }),

    "get-preference": tool({
      description: "Read a standing store preference by key.",
      inputSchema: z.object({ key: z.string() }),
      execute: async (args) => preferences.getPreference(args),
    }),

    "close-day": tool({
      description: "Close the day: totals sales, tax collected, and cash/UPI/card split for a date (defaults to today, IST).",
      inputSchema: z.object({ date: z.string().optional().describe("YYYY-MM-DD, defaults to today") }),
      execute: async (args) => analytics.closeDay(args),
    }),

    "generate-invoice-pdf": tool({
      description: "Generate a GST-correct PDF invoice for a finalized bill. If billId is omitted, uses the most recently finalized bill in this chat.",
      inputSchema: z.object({ billId: z.number().optional() }),
      execute: async (args) => {
        const billId = args.billId ?? billing.getLatestBillForChat(chatId, "finalized")?.id;
        if (!billId) return { status: "error", message: "No finalized bill found for this chat yet." };
        return generateInvoicePdf({ billId });
      },
    }),

    "generate-analysis-deck": tool({
      description: "Generate a PPTX business-analysis deck (sales, top items, GST collected, stock health) with real charts, for a trailing period.",
      inputSchema: z.object({ periodDays: z.number().int().positive().max(90).optional().describe("Defaults to 7") }),
      execute: async (args) => generateAnalysisDeck(args),
    }),
  };
}
