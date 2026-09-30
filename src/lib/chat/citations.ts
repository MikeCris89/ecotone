// Which records an answer rests on. Evidence comes only from the tool results in the answer's own
// message, never from the model's text: an ID the model writes is kept only if a tool returned it.
// No server imports, so the chat panel (10c) can use it.
import { isToolUIPart, type UIMessage } from "ai";
import type { Evidence, ToolResult } from "@/lib/agent/contract";

/** Every evidence record the tools returned in this assistant message, first occurrence kept. */
export function turnEvidence(message: UIMessage): Evidence[] {
	const seen = new Set<string>();
	return message.parts
		.flatMap((part) =>
			isToolUIPart(part) && part.state === "output-available"
				? ((part.output as Partial<ToolResult<unknown>> | null)?.evidence ?? [])
				: [],
		)
		.filter((evidence) => {
			const key = `${evidence.source}:${evidence.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

// [source:id], as the system prompt asks. FIRMS IDs contain colons and commas but no spaces or "]".
export const CITATION = /\[(inaturalist|firms|open-meteo):([^\]\s]+)\]/g;

/** The records cited inline in `text` that are in `evidence`, in citation order. Anything else is dropped. */
export function validCitations(text: string, evidence: Evidence[]): Evidence[] {
	const cited: Evidence[] = [];
	for (const [, source, id] of text.matchAll(CITATION)) {
		const match = evidence.find((record) => record.source === source && record.id === id);
		if (match && !cited.includes(match)) cited.push(match);
	}
	return cited;
}
