# Demo recording script (4-5 min)

Record your screen with Telegram open, chatting with the bot. Suggested flow, matching the brief's required scenario exactly:

1. **Receive stock** — "50 packets of Maggi came in, cost ₹12, MRP ₹14"
2. **Multi-item bill with an edit** —
   - "make a bill: 2kg sugar, 1 aashirvaad atta 5kg, 4 maggi, 1 amul butter, upi"
   - "drop the butter, make it 6 maggi"
   - "show me the bill" (confirms the edit landed before finalizing)
   - "finalize it"
3. **Oversell guard** — try to bill something absurd, e.g. "make a bill: 500kg loose rice" → show the agent refusing with the real stock number, not a crash.
4. **Khata cycle** —
   - "put ₹500 on Ramesh's credit"
   - "ramesh paid ₹300"
   - "what's Ramesh's balance?"
5. **Generate a PDF invoice** — "send me that bill as a PDF" → show the file arriving in Telegram, open it, point at the GST breakup.
6. **Generate the analysis deck** — "make this week's sales analysis deck" → open the PPTX, show a chart is a real chart (click it / show it's editable), not a picture.
7. **Set a preference** — "always assume UPI unless I say cash" → then start a fresh bill without naming a payment mode, showing it defaults correctly.
8. **Memory across sessions** — send `/new`, then ask "what's Ramesh's balance?" again → shows it's still correct after the conversation was cleared.

Keep narration brief — say what you're about to type, let the response speak for itself.
