# Nebula Supermarket Ops Agent

A conversational agent that runs a small Indian kirana store end-to-end over Telegram. No web app, no admin panel, no forms — the chat is the product.

## Harness, and why

Built on the **Vercel AI SDK**'s tool-calling agent loop (`generateText` with `tools` + `stopWhen: stepCountIs(n)`), using **Google Gemini** as the model. This is one of the harnesses the brief names directly, and it was chosen over the Claude Agent SDK for one practical reason: this build had to be zero-cost, and Gemini's free tier (no card required) made that possible while keeping a real multi-step, tool-orchestrated agent loop — `stopWhen: stepCountIs(n)` lets the model chain several tool calls (e.g. start-bill → add-item → add-item → set-payment-mode) within a single turn before replying, exactly the "observe → reason → act → feed back → continue" loop the brief asks for. Swapping the model provider (e.g. to Groq, or to Claude via `@ai-sdk/anthropic`) is a one-line change in `src/agent/index.ts` — the tool/skill layer underneath doesn't change at all.

## Control loop

`runAgentTurn(chatId, text)` in `src/agent/index.ts` is the whole loop: load this chat's persisted transcript → append the new message → call the model with the full tool set bound to this chat → the model calls zero or more tools, sees each result, and decides whether to call another or reply → persist everything that happened back to SQLite. Telegram's job (`src/telegram/bot.ts`) is thin on purpose: dedupe the incoming update, hand the text to the loop, send back the text and any generated files. All reasoning about *what* to do lives in the model + system prompt; all reasoning about *whether it's allowed* lives in the tools below.

## Skill / tool design

Twenty small tools (`src/tools/*.ts`, wrapped for the SDK in `src/agent/tools.ts`), one per real-world action from the brief's capability table (receive stock, add product, add/edit/remove a bill line, finalize, check stock, low-stock, khata credit/payment/balance, close day, set/get preference, generate invoice, generate deck). No intent router, no if/elif on message text anywhere — the model picks tools by their descriptions and Zod-typed arguments. Every tool returns a typed `status`: `ok`, `needs_clarification` (ambiguous product name — the model must ask, never guess), `confirmation_required` (e.g. a khata overpayment), or `error` (a refused guard). That contract is what keeps business logic out of the prompt: a tool decides whether an action is valid; the model only decides how to talk about the result.

## The hard parts

1. **Grounding** — prices, GST rates, HSN codes and stock all come from the `products` table via tools (`inventory.ts`). The model has no other source of truth and is instructed never to state a number it didn't get from a tool.
2. **Oversell guard** — enforced in `billing.ts` at the SQL layer: `UPDATE products SET qty = qty - ? WHERE id = ? AND qty >= ?`. If the row doesn't match, `changes = 0` and the guard fires — it can't be bypassed by the model or the prompt.
3. **GST correctness** — isolated entirely in `src/gst/gst.ts`: per-line CGST/SGST split, paisa-level rounding, and a single bill-level round-off. Nothing outside this file computes tax.
4. **Multi-turn bills** — one open draft bill per chat (`conversation_state.active_bill_id`); `add-bill-item` / `set-bill-item-quantity` / `remove-bill-item` mutate it across as many messages as needed; stock only moves on `finalize-bill`.
5. **Idempotency** — every Telegram message is claimed once via a `chatId:messageId` key (`telegram/idempotency.ts`) before it reaches the agent at all; separately, `finalizeBill` checks bill status first and is a no-op on a bill that's already finalized, so even a duplicate *tool call* (not just a duplicate delivery) can't double-bill.
6. **Concurrency** — Node is single-threaded and `better-sqlite3` executes synchronously, so the entire finalize (stock checks + decrements + status flip) runs inside one `db.transaction(...)` with no `await` inside it — no other chat's handler can interleave mid-transaction. The atomic `UPDATE...WHERE qty>=?` per line is the second, independent layer of protection.
7. **Guardrails** — `add-product` refuses MRP below cost price; `record-khata-payment` refuses a payment against a customer with no khata, and requires explicit `confirm: true` before recording a payment larger than the balance owed.
8. **Real artifacts** — `src/docs/invoice.ts` (pdfkit) renders a GST-correct tax invoice per finalized bill; `src/docs/deck.ts` (pptxgenjs) renders a PPTX with native bar/pie charts built from real aggregated sales data (`analytics.ts`) — not screenshots, not static text.
9. **Memory across sessions** — SQLite (`data/store.db`) is the only source of truth for stock, bills, khata and preferences. `/new` (`telegram/bot.ts` → `history.ts`) deletes only that chat's `conversation_messages` transcript; every other table is untouched, so a preference set last week still applies after a fresh `/new` chat and a process restart.

## Project layout

```
src/
  db/          SQLite schema + seed catalog
  gst/         tax math, used nowhere else
  tools/       the 20 skills (inventory, billing, khata, preferences, analytics)
  docs/        PDF invoice + PPTX deck generators
  agent/       system prompt, tool wiring, the control loop
  telegram/    bot wiring + idempotency
tests/         gst math, oversell guard, idempotency
```

See `DEPLOY.md` for setup and `DEMO_SCRIPT.md` for the recording checklist.
