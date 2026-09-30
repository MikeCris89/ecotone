// The chat history the model sees. Earlier turns are only the question and the final answer text:
// their tool calls and results are dropped, so follow-ups still work and the cost of a turn doesn't
// grow with the conversation. The client sends the history, so nothing in it is trusted: system
// messages and tool results from the client never reach the model.
import { z } from "zod";

export const MAX_MESSAGE_CHARS = 2000;
// The question plus the two turns before it.
const HISTORY_MESSAGES = 5;
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
function answerText(parts: Part[]) {
	const lastStep = parts.findLastIndex((part) => part.type === "step-start");
	return textOf(parts.slice(lastStep + 1)).slice(0, MAX_ANSWER_CHARS);
}

/** The last few turns as model messages, starting with a question. */
export function toModelMessages(messages: ChatMessage[]): TextMessage[] {
	const recent = messages.slice(-HISTORY_MESSAGES);
	const first = recent.findIndex((message) => message.role === "user");
	return recent.slice(first === -1 ? recent.length : first).map((message) =>
		message.role === "user"
			? { role: "user", content: textOf(message.parts) }
			: { role: "assistant", content: answerText(message.parts) || NO_ANSWER },
	);
}

/** Why the messages can't be sent to the model, or null if they can. */
export function messagesError(messages: TextMessage[]): string | null {
	const last = messages.at(-1);
	if (last?.role !== "user" || last.content.length === 0) return "The last message must be a question.";
	const tooLong = messages.some((message) => message.role === "user" && message.content.length > MAX_MESSAGE_CHARS);
	return tooLong ? `Messages can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.` : null;
}
