// Asks the deployed chat a question the way the chat panel does, and reads the streamed reply
// back into the message the panel would show.
import {
	getToolName,
	isToolUIPart,
	parseJsonEventStream,
	readUIMessageStream,
	type UIMessage,
	type UIMessageChunk,
	uiMessageChunkSchema,
} from "ai";
import type { ToolResult } from "@/lib/agent/contract";
import { citeAnswer, turnEvidence } from "@/lib/chat/citations";
import { type ChatContext, REVIEWER_HEADER } from "@/lib/chat/context";
import { answerText } from "@/lib/chat/messages";

const BASE_URL = process.env.EVAL_BASE_URL || "https://ecotone-iota.vercel.app";
// Production's reviewer key: the public bucket allows 5 questions an hour, fewer than one run.
const REVIEWER_KEY = process.env.EVAL_REVIEWER_KEY;

// MAX_STEPS in src/app/api/chat/route.ts, copied since a route file exports only route handlers
// and config. Used to recognise a reply that reached the limit.
export const MAX_STEPS = 8;

// Views as the map would send them. The statewide one reaches past California's box, as the
// zoomed-out map does; the route clips it.
export const VIEWS = {
	statewide: { west: -126, south: 31.5, east: -113, north: 42.5 },
	bayArea: { west: -122.6, south: 37.2, east: -121.7, north: 38.0 },
	sacramento: { west: -121.6, south: 38.5, east: -121.4, north: 38.65 },
	// East of the state line, inside California's box.
	reno: { west: -119.95, south: 39.4, east: -119.65, north: 39.65 },
} satisfies Record<string, ChatContext["view"]>;

/** The map's context for a view: the whole window shown, the timeline ending at the server clock. */
export const contextFor = (view: ChatContext["view"], window: ChatContext["window"] = "7d"): ChatContext => ({
	view,
	window,
	hour: null,
	end: null,
});

type ParsedChunk =
	ReturnType<typeof parseJsonEventStream<UIMessageChunk>> extends ReadableStream<infer T> ? T : never;

export type ToolCall ={ name: string; output: ToolResult<unknown> | null; failed: boolean };

export type Reply = {
	question: UIMessage;
	message: UIMessage;
	// The final step's text, as the panel shows it and the route judges no_answer.
	text: string;
	tools: ToolCall[];
	steps: number;
	// Distinct citations no tool in the turn returned, counted as the route logs them.
	unmatched: number;
};

/**
 * Sends a question with the given context (and an earlier conversation, if any) to POST /api/chat,
 * as the chat panel does: the context in the body and in the question's metadata.
 */
export async function ask(text: string, context: ChatContext, history: UIMessage[] = []): Promise<Reply> {
	if (!REVIEWER_KEY) throw new Error("Set EVAL_REVIEWER_KEY (production's reviewer key) in .env.local");
	const question: UIMessage = {
		id: crypto.randomUUID(),
		role: "user",
		parts: [{ type: "text", text }],
		metadata: { context },
	};
	const response = await fetch(`${BASE_URL}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", [REVIEWER_HEADER]: REVIEWER_KEY },
		body: JSON.stringify({ messages: [...history, question], context }),
	});
	if (!response.ok || !response.body) throw new Error(`Chat answered ${response.status}: ${await response.text()}`);

	// As the SDK's chat transport reads it: server-sent events, each a UI message chunk.
	const chunks = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(
		new TransformStream<ParsedChunk, UIMessageChunk>({
			transform(chunk, controller) {
				if (!chunk.success) throw chunk.error;
				controller.enqueue(chunk.value);
			},
		}),
	);
	let message: UIMessage | undefined;
	for await (const snapshot of readUIMessageStream({ stream: chunks, terminateOnError: true })) message = snapshot;
	if (!message) throw new Error("The chat stream ended without a message");

	const tools = message.parts.filter(isToolUIPart).map((part) => ({
		name: getToolName(part),
		output: part.state === "output-available" ? (part.output as ToolResult<unknown>) : null,
		failed: part.state === "output-error",
	}));
	const texts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
	return {
		question,
		message,
		text: answerText(message.parts),
		tools,
		steps: message.parts.filter((part) => part.type === "step-start").length,
		unmatched: citeAnswer(texts, turnEvidence(message)).unmatched,
	};
}

/** The successful results of one tool in a reply. */
export const outputsOf = (reply: Reply, name: string) =>
	reply.tools.flatMap((tool) => (tool.name === name && tool.output ? [tool.output] : []));

// A negation in the sentence: "I can't make population claims" uses a banned word to refuse it.
const NEGATION = /\b(not|no|never|cannot|can't|unable|without|neither|nor)\b|n't\b|n’t\b/i;

/**
 * The answer's sentences that match a pattern and aren't negated. A rough line between stating
 * something and refusing it, strict enough to catch a plain claim.
 */
export function affirmed(text: string, pattern: RegExp): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.filter((sentence) => pattern.test(sentence) && !NEGATION.test(sentence));
}
