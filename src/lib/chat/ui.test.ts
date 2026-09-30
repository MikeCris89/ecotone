import { APICallError, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { answerMissing, chatError, parseAnswer, stepLabel, suggestedQuestions } from "@/lib/chat/ui";

function apiError(status: number, responseBody: string) {
	return new APICallError({
		message: responseBody,
		url: "/api/chat",
		requestBodyValues: undefined,
		statusCode: status,
		responseBody,
	});
}

function assistant(parts: UIMessage["parts"]): UIMessage {
	return { id: "a1", role: "assistant", parts };
}

describe("stepLabel", () => {
	it("labels each chat tool, and anything else generically", () => {
		expect(stepLabel("summarize_detections")).toBe("Finding satellite thermal detection clusters");
		expect(stepLabel("get_data_status")).toBe("Checking data freshness and coverage");
		expect(stepLabel("something_new")).toBe("Querying the data");
	});
});

describe("suggestedQuestions", () => {
	it("offers the thermal activity question only when there are detections and observations", () => {
		const loaded = { window: "7d" as const, observations: true, detections: false, weather: true };
		expect(suggestedQuestions(loaded).some((q) => q.includes("thermal"))).toBe(false);
		expect(suggestedQuestions({ ...loaded, detections: true })).toContain(
			"What wildlife was recorded near thermal activity in the last 7 days?",
		);
		expect(
			suggestedQuestions({ ...loaded, detections: true, observations: false }).some((q) => q.includes("thermal")),
		).toBe(false);
	});

	it("names the selected window and always offers the freshness question", () => {
		expect(suggestedQuestions({ window: "24h", observations: true, detections: false, weather: false })).toEqual([
			"What species have been recorded in this area in the last 24 hours?",
			"How fresh is the data right now?",
		]);
		expect(suggestedQuestions({ window: "3d", observations: false, detections: false, weather: false })).toEqual([
			"How fresh is the data right now?",
		]);
	});
});

describe("chatError", () => {
	it("shows the route's own message, with the bucket a 429 names", () => {
		const body = JSON.stringify({
			ok: false,
			error: "Daily demo limit reached. It resets at midnight PT.",
			bucket: "reviewer",
			limit: "daily",
			retryAt: "2026-10-01T07:00:00.000Z",
		});
		expect(chatError(apiError(429, body))).toEqual({
			message: "Daily demo limit reached. It resets at midnight PT.",
			bucket: "reviewer",
		});
		const invalid = JSON.stringify({ ok: false, error: "The last message must be a question." });
		expect(chatError(apiError(400, invalid))).toEqual({ message: "The last message must be a question.", bucket: null });
	});

	it("falls back to a generic message for anything else", () => {
		const generic = { message: "Something went wrong. Try again.", bucket: null };
		expect(chatError(apiError(504, "<html>Gateway timeout</html>"))).toEqual(generic);
		expect(chatError(apiError(500, ""))).toEqual(generic);
		expect(chatError(new TypeError("Failed to fetch"))).toEqual(generic);
	});
});

describe("answerMissing", () => {
	it("is true when no text follows the last tool step", () => {
		const toolCall = {
			type: "tool-get_data_status",
			toolCallId: "t1",
			state: "input-available",
			input: {},
		} as const;
		const step = { type: "step-start" } as const;
		expect(answerMissing(assistant([step, { type: "text", text: "Let me check." }, step, toolCall]))).toBe(true);
		expect(answerMissing(assistant([step, toolCall, step, { type: "text", text: "All current." }]))).toBe(false);
		expect(answerMissing(assistant([]))).toBe(true);
	});
});

describe("parseAnswer", () => {
	it("splits paragraphs on blank lines and joins wrapped lines", () => {
		expect(parseAnswer("First line\nstill first.\n\nSecond.")).toEqual([
			{
				type: "paragraph",
				inlines: [
					{ type: "text", text: "First line" },
					{ type: "text", text: " " },
					{ type: "text", text: "still first." },
				],
			},
			{ type: "paragraph", inlines: [{ type: "text", text: "Second." }] },
		]);
	});

	it("reads bullet and numbered lists, kept apart", () => {
		expect(parseAnswer("Top:\n- one\n* two\n1. first\n2) second")).toEqual([
			{ type: "paragraph", inlines: [{ type: "text", text: "Top:" }] },
			{ type: "list", ordered: false, items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]] },
			{ type: "list", ordered: true, items: [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]] },
		]);
	});

	it("keeps a numbered list together across blank lines", () => {
		expect(parseAnswer("1. a\n\n2. b")).toEqual([
			{ type: "list", ordered: true, items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]] },
		]);
	});

	it("finds bold text and citations inline", () => {
		const text = "**7 recorded observations** near the largest cluster [inaturalist:123456], [firms:N20:2026-09-29T21:30Z,38.1,-120.2].";
		expect(parseAnswer(text)).toEqual([
			{
				type: "paragraph",
				inlines: [
					{ type: "bold", text: "7 recorded observations" },
					{ type: "text", text: " near the largest cluster " },
					{ type: "citation", source: "inaturalist", id: "123456" },
					{ type: "text", text: ", " },
					{ type: "citation", source: "firms", id: "N20:2026-09-29T21:30Z,38.1,-120.2" },
					{ type: "text", text: "." },
				],
			},
		]);
	});

	it("leaves other markdown as plain text", () => {
		expect(parseAnswer("## Heading\n| a | b |\n**unclosed")).toEqual([
			{
				type: "paragraph",
				inlines: [
					{ type: "text", text: "## Heading" },
					{ type: "text", text: " " },
					{ type: "text", text: "| a | b |" },
					{ type: "text", text: " " },
					{ type: "text", text: "**unclosed" },
				],
			},
		]);
	});
});
