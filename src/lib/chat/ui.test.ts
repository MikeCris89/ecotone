import { APICallError, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	answerMissing,
	chatError,
	loadedData,
	parseAnswer,
	remainingNote,
	retryMessage,
	stepLabel,
	suggestedQuestions,
} from "@/lib/chat/ui";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { InatMapRow } from "@/lib/inaturalist/map";

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

describe("loadedData", () => {
	const END = "2026-09-30T20:00:00.000Z";
	const DAY = 24 * 60 * 60;
	// Three days before the layers' end: in the 7-day window, outside the last 24 hours.
	const threeDaysAgo = Date.parse(END) / 1000 - 3 * DAY;
	const inat: InatMapRow = [1, -122, 37, threeDaysAgo, threeDaysAgo, "Aves", 10, false, 0];
	const firms: FirmsMapRow = ["snpp:1", -122, 37, threeDaysAgo, 5];

	it("checks the selected window, not the last day", () => {
		const loaded = (window: "24h" | "7d") =>
			loadedData(window, { rows: [inat], end: END }, { rows: [firms], end: END }, { rows: [], end: END });
		expect(loaded("7d")).toEqual({ window: "7d", observations: true, detections: true, weather: false });
		expect(loaded("24h")).toEqual({ window: "24h", observations: false, detections: false, weather: false });
	});

	it("has nothing before the layers load", () => {
		expect(loadedData("7d", undefined, undefined, undefined)).toEqual({
			window: "7d",
			observations: false,
			detections: false,
			weather: false,
		});
	});
});

describe("remainingNote", () => {
	it("names whichever limit comes first", () => {
		expect(remainingNote({ hourly: 4, daily: 12 })).toBe("4 questions left this hour");
		expect(remainingNote({ hourly: 5, daily: 1 })).toBe("1 question left today");
		expect(remainingNote({ hourly: 0, daily: 0 })).toBe("0 questions left today");
		expect(remainingNote(null)).toBeNull();
	});
});

describe("retryMessage", () => {
	const utcClock = (date: Date) =>
		new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date);
	const now = new Date("2026-09-30T12:24:00Z");

	it("gives the wait and the user's clock time", () => {
		expect(retryMessage("hourly", new Date("2026-09-30T13:02:00Z"), now, utcClock)).toBe(
			"Hourly limit reached. Try again in 38 min (1:02 PM).",
		);
		expect(retryMessage("daily", new Date("2026-10-01T07:00:00Z"), now, utcClock)).toBe(
			"Daily demo limit reached. Try again in 18 h 36 min (7:00 AM).",
		);
		expect(retryMessage("daily", new Date("2026-09-30T14:24:00Z"), now, utcClock)).toBe(
			"Daily demo limit reached. Try again in 2 h (2:24 PM).",
		);
	});

	it("is used for a 429 that says when its limit lifts", () => {
		const body = JSON.stringify({
			ok: false,
			error: "Hourly limit reached. Try again after Sep 30, 6:02 AM PT.",
			bucket: "public",
			limit: "hourly",
			retryAt: "2026-09-30T13:02:00.000Z",
		});
		expect(chatError(apiError(429, body), now, utcClock)).toEqual({
			message: "Hourly limit reached. Try again in 38 min (1:02 PM).",
			bucket: "public",
		});
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
		// Without a reset time, the route's own message.
		const withoutRetry = JSON.stringify({ ...JSON.parse(body), retryAt: undefined });
		expect(chatError(apiError(429, withoutRetry))).toEqual({
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
					{ type: "bold", inlines: [{ type: "text", text: "7 recorded observations" }] },
					{ type: "text", text: " near the largest cluster " },
					{ type: "citation", source: "inaturalist", id: "123456" },
					{ type: "text", text: ", " },
					{ type: "citation", source: "firms", id: "N20:2026-09-29T21:30Z,38.1,-120.2" },
					{ type: "text", text: "." },
				],
			},
		]);
	});

	it("finds citations and italics inside bold text", () => {
		expect(parseAnswer("**1,601 detections [firms:N20:2026-09-29T21:30Z,38.1,-120.2] near *Pinus*.**")).toEqual([
			{
				type: "paragraph",
				inlines: [
					{
						type: "bold",
						inlines: [
							{ type: "text", text: "1,601 detections " },
							{ type: "citation", source: "firms", id: "N20:2026-09-29T21:30Z,38.1,-120.2" },
							{ type: "text", text: " near " },
							{ type: "italic", text: "Pinus" },
							{ type: "text", text: "." },
						],
					},
				],
			},
		]);
	});

	it("reads '• ' bullets as a list", () => {
		expect(parseAnswer("• one\n• two")).toEqual([
			{ type: "list", ordered: false, items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]] },
		]);
	});

	it("reads *italic* and _italic_, but not spaced stars or snake_case", () => {
		expect(parseAnswer("*Calypte anna* and _Sceloporus occidentalis_")).toEqual([
			{
				type: "paragraph",
				inlines: [
					{ type: "italic", text: "Calypte anna" },
					{ type: "text", text: " and " },
					{ type: "italic", text: "Sceloporus occidentalis" },
				],
			},
		]);
		expect(parseAnswer("2 * 3 * 4 in summarize_detections")).toEqual([
			{ type: "paragraph", inlines: [{ type: "text", text: "2 * 3 * 4 in summarize_detections" }] },
		]);
	});

	it("reads # headings as their own block", () => {
		expect(parseAnswer("## Largest cluster\n1,601 detections.")).toEqual([
			{ type: "heading", inlines: [{ type: "text", text: "Largest cluster" }] },
			{ type: "paragraph", inlines: [{ type: "text", text: "1,601 detections." }] },
		]);
	});

	it("leaves other markdown as plain text", () => {
		expect(parseAnswer("| a | b |\n**unclosed")).toEqual([
			{
				type: "paragraph",
				inlines: [
					{ type: "text", text: "| a | b |" },
					{ type: "text", text: " " },
					{ type: "text", text: "**unclosed" },
				],
			},
		]);
	});
});
