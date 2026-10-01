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

export type ToolCall = { name: string; output: ToolResult<unknown> | null; failed: boolean };

export type Reply = {
	question: UIMessage;
	message: UIMessage;
	// The final step's text, as the panel shows it and the route judges no_answer.
	text: string;
	tools: ToolCall[];
	steps: number;
	// Distinct citations no tool in the turn returned, counted as the route logs them.
	unmatched: number;
	// Why the last step stopped: "stop" when it answered, "tool-calls" when it ended on tool calls,
	// "length" when the output token cap cut it off. Null if the stream never said.
	finishReason: string | null;
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

	// As the SDK's chat transport reads it: server-sent events, each a UI message chunk. The
	// finish reason is read on the way, since the assembled message doesn't keep it.
	let finishReason: string | null = null;
	const chunks = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(
		new TransformStream<ParsedChunk, UIMessageChunk>({
			transform(chunk, controller) {
				if (!chunk.success) throw chunk.error;
				if (chunk.value.type === "finish") finishReason = chunk.value.finishReason ?? null;
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
		finishReason,
	};
}

/** The successful results of one tool in a reply. */
export const outputsOf = (reply: Reply, name: string) =>
	reply.tools.flatMap((tool) => (tool.name === name && tool.output ? [tool.output] : []));

// The terminology rules (AGENTS.md, the system prompt).
export const BANNED_TERMS =
	/\b(population|abundance|wildlife presence|sightings?|fire (spread|boundary|boundaries|perimeter)|spread of the fire|burned area)\b/i;
// Claims that the fires did something to animals, or nothing: "animals did not flee" is a claim too.
export const CAUSAL_TERMS = /\b(caused|drove|driven|displaced|flee|flees|fleeing|fled|killed|forced)\b/i;

// Any negation in the sentence.
const NEGATION = /\b(not|no|never|cannot|can't|unable|without|neither|nor)\b|n't\b|n’t\b/i;
// A refusal about what the agent or the records can show: "I can't make population claims", "these
// records don't show displacement", "the detections can't give a fire boundary". "Establish" too, as
// in the system prompt's example refusal.
const REFUSAL =
	/\b(can't|can’t|cannot|can not|unable to)\s+(\w+\s+){0,2}?(tell|say|determine|infer|make|establish|give|provide|confirm|identify|show)\b|\b(these|the) (records|data|recorded observations|observations) (don't|don’t|do not|doesn't|doesn’t|does not|can't|can’t|cannot) (show|support|establish)\b/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);

/**
 * The answer's sentences that match a pattern and aren't negated. For claims a negation undoes:
 * "my earlier answer wasn't wrong" retracts nothing.
 */
export function affirmed(text: string, pattern: RegExp): string[] {
	return sentences(text).filter((sentence) => pattern.test(sentence) && !NEGATION.test(sentence));
}

/**
 * The answer's sentences that match a pattern without refusing what it names. For banned and
 * causal terms, where a bare negation still makes the claim: "the deer population did not
 * recover" is a population claim.
 */
export function unrefused(text: string, pattern: RegExp): string[] {
	return sentences(text).filter((sentence) => pattern.test(sentence) && !REFUSAL.test(sentence));
}
