// Which records an answer rests on. Evidence comes only from the tool results in the answer's own
// message, never from the model's text: an ID the model writes is kept only if a tool returned it.
// No server imports: the chat panel and the chat route share it.
import { isToolUIPart, type UIMessage } from "ai";
import type { Evidence, ToolResult } from "@/lib/agent/contract";

/** Every evidence record in these tool outputs, first occurrence kept. */
export function evidenceOf(outputs: unknown[]): Evidence[] {
	const seen = new Set<string>();
	return outputs
		.flatMap((output) => (output as Partial<ToolResult<unknown>> | null)?.evidence ?? [])
		.filter((evidence) => {
			const key = `${evidence.source}:${evidence.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/** Every evidence record the tools returned in this assistant message, first occurrence kept. */
export function turnEvidence(message: UIMessage): Evidence[] {
	return evidenceOf(
		message.parts.flatMap((part) => (isToolUIPart(part) && part.state === "output-available" ? [part.output] : [])),
	);
}

// [source:id], as the system prompt asks. The source is everything before the first colon: FIRMS
// and weather IDs contain colons (and FIRMS IDs commas), but no spaces or "]".
export const CITATION = /\[(inaturalist|firms|open-meteo):([^\]\s]+)\]/g;
// With the spaces before it, so removing an unmatched one doesn't leave "records ." behind. Not
// newlines, which would join a list item to the line above.
const CITATION_WITH_SPACE = new RegExp(`[ \\t]*${CITATION.source}`, "g");

export type CitedAnswer = {
	// The answer's texts with every citation no tool returned removed.
	texts: string[];
	// The records cited, in order of first citation: record n is cited as number n + 1.
	cited: Evidence[];
	// Distinct citations no tool in the turn returned: the same garbled ID twice counts once.
	unmatched: number;
};

/** An answer's citations checked against the turn's evidence (decisions.md, 31 and 38). */
export function citeAnswer(texts: string[], evidence: Evidence[]): CitedAnswer {
	const cited: Evidence[] = [];
	const unmatched = new Set<string>();
	const kept = texts.map((text) =>
		text.replace(CITATION_WITH_SPACE, (citation, source: string, id: string) => {
			const match = evidence.find((record) => record.source === source && record.id === id);
			if (!match) {
				unmatched.add(`${source}:${id}`);
				return "";
			}
			if (!cited.includes(match)) cited.push(match);
			return citation;
		}),
	);
	return { texts: kept, cited, unmatched: unmatched.size };
}
