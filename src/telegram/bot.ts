import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";
import { runAgentTurn } from "../agent/index.js";
import { clearMessages } from "../agent/history.js";
import { claimOnce } from "./idempotency.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error("GOOGLE_GENERATIVE_AI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

console.log("Nebula Supermarket Ops Agent is live and polling Telegram...");

bot.on("polling_error", (err) => console.error("[polling_error]", err.message));

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const dedupKey = `${chatId}:${msg.message_id}`;

  // Idempotency guard first, before anything else touches the DB or the model.
  if (!claimOnce(dedupKey)) {
    console.log(`[dedup] skipped repeated delivery of ${dedupKey}`);
    return;
  }

  try {
    if (!msg.text) {
      await bot.sendMessage(chatId, "I can only read plain text messages right now - stock, bills, khata and reports all work in plain English.");
      return;
    }

    const text = msg.text.trim();

    if (text === "/start") {
      await bot.sendMessage(
        chatId,
        "Nebula Supermarket Ops Agent here. Tell me what happened - stock in, a bill, a khata update, a stock check, or 'close the day'. Send /new to start a fresh conversation (your store data and preferences stay exactly as they are)."
      );
      return;
    }

    if (text === "/new") {
      clearMessages(chatId);
      await bot.sendMessage(chatId, "Started a new chat. Stock, bills, khata and preferences are all unchanged - only this conversation's memory was cleared.");
      return;
    }

    await bot.sendChatAction(chatId, "typing");
    const result = await runAgentTurn(chatId, text);

    if (result.text) await bot.sendMessage(chatId, result.text);
    for (const att of result.attachments) {
      await bot.sendDocument(chatId, fs.createReadStream(att.filePath));
    }
  } catch (err) {
    console.error(`[error] chat ${chatId}:`, err);
    await bot.sendMessage(chatId, "Something went wrong on my end handling that - nothing was changed. Try again in a moment.");
  }
});
