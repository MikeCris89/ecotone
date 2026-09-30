import { anthropic } from "@ai-sdk/anthropic";
import {
	createUIMessageStreamResponse,
	isStepCount,
	type SystemModelMessage,
	streamText,
	toUIMessageStream,
} from "ai";
import { z } from "zod";
import { chatContextSchema, contextPrompt, resolveContext } from "@/lib/chat/context";
import { chatMessageSchema, messagesError, toModelMessages } from "@/lib/chat/messages";
import { SYSTEM_PROMPT } from "@/lib/chat/prompt";
import { CHAT_TOOLS } from "@/lib/chat/tools";
import { getDataset, LIVE_DATASET_SLUG } from "@/lib/datasets";

// A reply with several tool calls can take 20+ seconds; this bounds a stuck one.
export const maxDuration = 120;

const CHAT_MODEL = "claude-sonnet-5-5";
// Model calls per question, tool rounds included. The last one is told to answer, so a question
// that uses them all still ends with one.
const MAX_STEPS = 8;
const LAST_STEP_INSTRUCTION =
	"You have used all your tool calls for this question. Don't call any more tools: answer now from the results above, and say what you couldn't check.";
const MAX_OUTPUT_TOKENS = 2000;

const requestSchema = z.looseObject({
	messages: z.array(chatMessageSchema).min(1).max(200),
	context: chatContextSchema,
});

/**
 * The agent: POST /api/chat with useChat's messages and the map's context. Streams the answer as
 * AI SDK UI message parts, including each tool call and its result (evidence, coverage, limitations).
 */
export async function POST(request: Request) {
	const parsed = requestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ ok: false, error: "Invalid chat request" }, { status: 400 });

	const messages = toModelMessages(parsed.data.messages);
	const error = messagesError(messages);
	if (error) return Response.json({ ok: false, error }, { status: 400 });

	let dataset;
	try {
		dataset = await getDataset(LIVE_DATASET_SLUG);
	} catch (error) {
		console.error("Chat dataset lookup failed", error);
		return Response.json({ ok: false, error: "The chat is unavailable right now" }, { status: 500 });
	}
	const context = resolveContext(parsed.data.context, dataset, new Date());

	const instructions: SystemModelMessage[] = [
		// Anthropic caches everything up to this breakpoint: the tool definitions, then these rules.
		{
			role: "system",
			content: SYSTEM_PROMPT,
			providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
		},
		{ role: "system", content: contextPrompt(context) },
	];

	const result = streamText({
		model: anthropic(CHAT_MODEL),
		instructions,
		messages,
		tools: CHAT_TOOLS,
		stopWhen: isStepCount(MAX_STEPS),
		// Not toolChoice "none": the Anthropic provider implements it by removing the tools, and the
		// API rejects a history with tool calls but no tool definitions.
		prepareStep: ({ stepNumber }) =>
			stepNumber === MAX_STEPS - 1
				? { instructions: [...instructions, { role: "system", content: LAST_STEP_INSTRUCTION }] }
				: undefined,
		maxOutputTokens: MAX_OUTPUT_TOKENS,
		// A closed tab stops the model rather than paying for an answer nobody reads.
		abortSignal: request.signal,
	});

	return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
}
