import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/agent/contract";
import { turnEvidence, validCitations } from "@/lib/chat/citations";
import { MAX_MESSAGE_CHARS, messagesError, toModelMessages } from "@/lib/chat/messages";

const question = (text: string) => ({ role: "user" as const, parts: [{ type: "text", text }] });
const answer = (text: string) => ({ role: "assistant" as const, parts: [{ type: "text", text }] });

function evidence(source: Evidence["source"], id: string): Evidence {
	return {
		source,
		id,
		url: `https://example.com/${id}`,
		label: id,
		longitude: -120,
		latitude: 37,
		observedAt: "2026-09-29T10:00:00.000Z",
		retrievedAt: "2026-09-29T12:00:00.000Z",
		license: null,
		attribution: "Test",
	};
}

describe("toModelMessages", () => {
	it("sends an earlier answer as its final text, without its tool calls and results", () => {
		const toolTurn = {
			role: "assistant" as const,
			parts: [
				{ type: "step-start" },
				{ type: "text", text: "Let me check the detections." },
				{ type: "tool-summarize_detections", state: "output-available", output: { result: { matched: 12 } } },
				{ type: "step-start" },
				{ type: "text", text: "There were 12 satellite thermal detections." },
			],
		};
		expect(toModelMessages([question("Any detections?"), toolTurn, question("Where?")])).toEqual([
			{ role: "user", content: "Any detections?" },
			{ role: "assistant", content: "There were 12 satellite thermal detections." },
			{ role: "user", content: "Where?" },
		]);
	});

	it("keeps the question and the two turns before it, starting with a question", () => {
		const history = [1, 2, 3, 4].flatMap((n) => [question(`q${n}`), answer(`a${n}`)]);
		expect(toModelMessages([...history, question("q5")]).map((message) => message.content)).toEqual([
			"q3",
			"a3",
			"q4",
			"a4",
			"q5",
		]);
		expect(toModelMessages([answer("a1"), question("q2")]).map((message) => message.content)).toEqual(["q2"]);
	});

	it("drops earlier questions that got no answer, such as ones the route rejected", () => {
		const history = [question("q1"), answer("a1"), question(""), question("x".repeat(MAX_MESSAGE_CHARS + 1)), question("q2")];
		expect(toModelMessages(history).map((message) => message.content)).toEqual(["q1", "a1", "q2"]);
	});

	it("drops an earlier blank question even with an answer, and truncates a long one", () => {
		const history = [question(" "), answer("a1"), question("x".repeat(MAX_MESSAGE_CHARS + 50)), answer("a2"), question("q3")];
		expect(toModelMessages(history).map((message) => message.content.length)).toEqual([MAX_MESSAGE_CHARS, 2, 2]);
	});

	it("marks an answer that has no text", () => {
		const cutOff = { role: "assistant" as const, parts: [{ type: "step-start" }, { type: "tool-get_data_status" }] };
		expect(toModelMessages([question("q1"), cutOff, question("q2")])[1]).toEqual({
			role: "assistant",
			content: "(No answer was given.)",
		});
	});
});

describe("messagesError", () => {
	it("accepts a new question up to the limit and rejects a longer one", () => {
		expect(messagesError(toModelMessages([question("x".repeat(MAX_MESSAGE_CHARS))]))).toBeNull();
		expect(messagesError(toModelMessages([question("x".repeat(MAX_MESSAGE_CHARS + 1))]))).toBe(
			"Messages can be at most 2,000 characters.",
		);
	});

	it("checks only the new question: a rejected earlier one doesn't block later ones", () => {
		expect(messagesError(toModelMessages([question("x".repeat(MAX_MESSAGE_CHARS + 1)), question("q")]))).toBeNull();
		expect(messagesError(toModelMessages([question(" "), question("q")]))).toBeNull();
	});

	it("rejects a history that doesn't end with a question", () => {
		expect(messagesError(toModelMessages([question("q"), answer("a")]))).toBe("The last message must be a question.");
		expect(messagesError(toModelMessages([question("  ")]))).toBe("The last message must be a question.");
	});
});

describe("citations", () => {
	const message = {
		id: "m1",
		role: "assistant",
		parts: [
			{
				type: "tool-summarize_observations",
				toolCallId: "c1",
				state: "output-available",
				input: {},
				output: { evidence: [evidence("inaturalist", "101"), evidence("inaturalist", "102")] },
			},
			{
				type: "tool-summarize_detections",
				toolCallId: "c2",
				state: "output-available",
				input: {},
				output: { evidence: [evidence("firms", "snpp:2026-09-29T10:00:00.000Z:37.1,-120.2"), evidence("inaturalist", "101")] },
			},
			{ type: "tool-get_conditions", toolCallId: "c3", state: "output-error", input: {}, errorText: "failed" },
		],
	} as UIMessage;

	it("collects the evidence of every tool that returned in the turn, once each", () => {
		expect(turnEvidence(message).map((record) => `${record.source}:${record.id}`)).toEqual([
			"inaturalist:101",
			"inaturalist:102",
			"firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2",
		]);
	});

	it("keeps only cited IDs that a tool returned", () => {
		const text =
			"A Steller's jay [inaturalist:102], a detection [firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2], " +
			"an invented record [inaturalist:999], a wrong source [firms:101], and [inaturalist:102] again.";
		expect(validCitations(text, turnEvidence(message)).map((record) => record.id)).toEqual([
			"102",
			"snpp:2026-09-29T10:00:00.000Z:37.1,-120.2",
		]);
	});
});
