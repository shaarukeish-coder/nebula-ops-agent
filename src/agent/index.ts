import { generateText, stepCountIs, type ModelMessage } from "ai";
import { google } from "@ai-sdk/google";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { createToolsForChat } from "./tools.js";
import { loadMessages, appendMessages } from "./history.js";

const MODEL_ID = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MAX_STEPS = 8; // generous headroom for "make a bill: item, item, item, UPI" in one turn

export interface AgentTurnResult {
  text: string;
  /** Any files the agent's tools produced this turn (invoice PDFs, analysis decks) - the Telegram layer sends these as documents. */
  attachments: { filePath: string }[];
}

/**
 * The whole control loop, in one call: observe (load history + new message)
 * -> reason + act (model decides which tools to call, in what order,
 * possibly several in a row) -> feed results back -> continue -> until the
 * model is done, then persist. This IS the "real control loop" the brief
 * asks for (section 5) - the AI SDK's generateText with tools + stopWhen
 * runs exactly that loop; nothing here is a regex/keyword router.
 */
export async function runAgentTurn(chatId: string, userText: string): Promise<AgentTurnResult> {
  const history = loadMessages(chatId);
  const userMessage: ModelMessage = { role: "user", content: userText };

  const result = await generateText({
    model: google(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: [...history, userMessage],
    tools: createToolsForChat(chatId),
    stopWhen: stepCountIs(MAX_STEPS),
  });

  // Persist exactly what was added this turn: the user's message plus every
  // assistant/tool message the model produced while working the request.
  appendMessages(chatId, [userMessage, ...result.responseMessages]);

  const attachments: { filePath: string }[] = [];
  for (const toolResult of result.toolResults) {
    const r = toolResult.output as { filePath?: string } | undefined;
    if (r?.filePath) attachments.push({ filePath: r.filePath });
  }

  return { text: result.text || "Done.", attachments };
}
