// The chat history the model sees. Earlier turns are only the question and the final answer text:
// their tool calls and results are dropped, so follow-ups still work and the cost of a turn doesn't
// grow with the conversation. The client sends the history, so nothing in it is trusted: system
// messages and tool results from the client never reach the model.
import { z } from "zod";

// A question, not a document: long enough for a detailed one, short enough to bound input cost.
export const MAX_MESSAGE_CHARS = 500;
// Earlier question-and-answer pairs sent with the new question.
const HISTORY_TURNS = 2;
// Well above an honest answer (one step's output tokens), so only a forged history gets cut.
const MAX_ANSWER_CHARS = 8000;
const NO_ANSWER = "(No answer was given.)";

const partSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
export const chatMessageSchema = z.looseObject({
	role: z.enum(["user", "assistant"]),
	parts: z.array(partSchema).max(200),
});

type ChatMessage = z.infer<typeof chatMessageSchema>;
type Part = z.infer<typeof partSchema>;
// Plain text only: assignable to the AI SDK's ModelMessage.
type TextMessage = { role: "user"; content: string } | { role: "assistant"; content: string };

const textOf = (parts: Part[]) =>
	parts
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("")
		.trim();

/** An answer's final step: its text after the last tool call (UI messages mark steps with step-start). */
export function answerText(parts: Part[]) {
	const lastStep = parts.findLastIndex((part) => part.type === "step-start");
	return textOf(parts.slice(lastStep + 1)).slice(0, MAX_ANSWER_CHARS);
}

/**
 * The new message plus the last few earlier turns, as model messages. An earlier question counts
 * only if an answer followed it: one the route rejected (blank, too long) stays in the client's
 * history, and would otherwise make every later request fail too.
 */
export function toModelMessages(messages: ChatMessage[]): TextMessage[] {
	const turns: TextMessage[][] = [];
	for (let i = 0; i < messages.length - 2; i++) {
		const [question, answer] = [messages[i], messages[i + 1]];
		const text = textOf(question.parts).slice(0, MAX_MESSAGE_CHARS);
		if (question.role !== "user" || answer.role !== "assistant" || text.length === 0) continue;
		turns.push([
			{ role: "user", content: text },
			{ role: "assistant", content: answerText(answer.parts) || NO_ANSWER },
		]);
	}
	const last = messages.at(-1)!;
	const latest: TextMessage =
		last.role === "user"
			? { role: "user", content: textOf(last.parts) }
			: { role: "assistant", content: answerText(last.parts) };
	return [...turns.slice(-HISTORY_TURNS).flat(), latest];
}

/** Why the new message can't be sent to the model, or null if it can. Earlier ones were checked when sent. */
export function messagesError(messages: TextMessage[]): string | null {
	const last = messages.at(-1);
	if (last?.role !== "user" || last.content.length === 0) return "The last message must be a question.";
	return last.content.length > MAX_MESSAGE_CHARS
		? `Messages can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`
		: null;
}
