// The chat panel's logic, kept apart from React so it can be tested: tool step labels, which
// suggested questions the loaded data can answer, the route's error messages, and the light
// markdown answers use.
import { APICallError, type UIMessage } from "ai";
import { z } from "zod";
import type { Bucket } from "@/lib/chat/access";
import { CITATION } from "@/lib/chat/citations";
import { WINDOW_NAMES } from "@/lib/chat/context";
import { answerText } from "@/lib/chat/messages";
import type { CHAT_TOOLS } from "@/lib/chat/tools";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { InatMapRow } from "@/lib/inaturalist/map";
import { inatInWindow, instantInWindow, type MapWindow, windowBounds } from "@/lib/map-layers";

const STEP_LABELS: Record<keyof typeof CHAT_TOOLS, string> = {
	get_data_status: "Checking data freshness and coverage",
	summarize_observations: "Counting recorded observations",
	compare_periods: "Comparing recorded observations between periods",
	summarize_detections: "Finding satellite thermal detection clusters",
	observations_near_detections: "Looking for recorded observations near thermal detections",
	get_conditions: "Reading modeled conditions",
};

/** What the panel says while a tool runs. */
export function stepLabel(toolName: string): string {
	return STEP_LABELS[toolName as keyof typeof CHAT_TOOLS] ?? "Querying the data";
}

/** Whether the map has loaded each kind of record for the selected window. */
export type LoadedData = { window: MapWindow; observations: boolean; detections: boolean; weather: boolean };

type Loaded<Row> = { rows: Row[]; end: string } | undefined;

/**
 * Whether the loaded layers hold each kind of record in the selected window: the window, not the
 * timeline handle's day, since the questions name the window. All of the loaded map, not the view.
 */
export function loadedData(
	window: MapWindow,
	inaturalist: Loaded<InatMapRow>,
	firms: Loaded<FirmsMapRow>,
	weather: Loaded<unknown>,
): LoadedData {
	const inatSpan = inaturalist && windowBounds(inaturalist.end, window);
	const firmsSpan = firms && windowBounds(firms.end, window);
	return {
		window,
		observations: !!inatSpan && inaturalist!.rows.some(([, , , from, to]) => inatInWindow(from, to, inatSpan)),
		detections: !!firmsSpan && firms!.rows.some(([, , , time]) => instantInWindow(time, firmsSpan)),
		weather: !!weather?.rows.length,
	};
}

/**
 * Suggested questions, only those the loaded data can answer (brief 6.7): no question about thermal
 * activity without detections, none about species without recorded observations.
 */
export function suggestedQuestions({ window, observations, detections, weather }: LoadedData): string[] {
	const period = `the ${WINDOW_NAMES[window]}`;
	return [
		...(observations ? [`What species have been recorded in this area in ${period}?`] : []),
		...(observations && detections ? [`What wildlife was recorded near thermal activity in ${period}?`] : []),
		...(weather ? ["What are the modeled conditions here right now?"] : []),
		"How fresh is the data right now?",
	];
}

/**
 * A finished reply with no answer text after its last tool step: the model called a tool on its
 * last step, or the stream stopped. The server logs the same case as chat_requests.no_answer.
 */
export function answerMissing(message: UIMessage): boolean {
	return answerText(message.parts) === "";
}

/** The limit the user will reach first, as a short note; null when the count is unknown. */
export function remainingNote(remaining: { hourly: number; daily: number } | null): string | null {
	if (!remaining) return null;
	const [left, period] = remaining.hourly < remaining.daily ? [remaining.hourly, "this hour"] : [remaining.daily, "today"];
	return `${left} ${left === 1 ? "question" : "questions"} left ${period}`;
}

const GENERIC_ERROR = "Something went wrong. Try again.";
// The chat route's error body: every non-2xx answer carries a message meant for the user.
// A 429's also says which limit and when it lifts.
const errorBodySchema = z.object({
	error: z.string(),
	bucket: z.enum(["public", "reviewer"]).optional(),
	limit: z.enum(["hourly", "daily"]).optional(),
	retryAt: z.iso.datetime().optional(),
});

const LIMIT_REACHED = { hourly: "Hourly limit reached.", daily: "Daily demo limit reached." };
const localClock = (date: Date) =>
	new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);

/**
 * When a limit lifts, in the user's own time: it's about their next question, not California's data.
 * E.g. "Try again in 38 min (1:02 PM)".
 */
export function retryMessage(limit: "hourly" | "daily", retryAt: Date, now: Date, clock = localClock): string {
	const minutes = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
	const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
	const wait = hours === 0 ? `${minutes} min` : `${hours} h${rest ? ` ${rest} min` : ""}`;
	return `${LIMIT_REACHED[limit]} Try again in ${wait} (${clock(retryAt)}).`;
}

/**
 * The message to show for a failed request, and the bucket when the route said (a 429 does). A
 * non-2xx response reaches useChat as an APICallError holding the body; anything else (a network
 * failure, a stream that broke mid-answer) gets a generic message. A limit's reset is given in the
 * user's time; the route's own message (in PT) is the fallback.
 */
export function chatError(
	error: Error,
	now = new Date(),
	clock = localClock,
): { message: string; bucket: Bucket | null } {
	if (APICallError.isInstance(error) && error.responseBody) {
		try {
			const body = errorBodySchema.safeParse(JSON.parse(error.responseBody));
			if (body.success) {
				const { error: message, bucket = null, limit, retryAt } = body.data;
				return { message: limit && retryAt ? retryMessage(limit, new Date(retryAt), now, clock) : message, bucket };
			}
		} catch {
			// Not JSON: a platform error page, not the route's own answer.
		}
	}
	return { message: GENERIC_ERROR, bucket: null };
}

export type Inline =
	| { type: "text"; text: string }
	| { type: "bold"; inlines: Inline[] }
	| { type: "italic"; text: string }
	| { type: "citation"; source: string; id: string };
export type Block =
	| { type: "paragraph"; inlines: Inline[] }
	| { type: "heading"; inlines: Inline[] }
	| { type: "list"; ordered: boolean; items: Inline[][] };

// Bold, a citation, then *italic* or _italic_ (scientific names). Italic markers must hug a word
// and not sit inside one, so "2 * 3 * 4" and snake_case stay plain text.
const INLINE = new RegExp(
	[
		"\\*\\*(.+?)\\*\\*",
		CITATION.source,
		"(?<![\\w*])\\*(?![\\s*])([^*\\n]+?)(?<!\\s)\\*(?![\\w*])",
		"(?<!\\w)_(?!\\s)([^_\\n]+?)(?<!\\s)_(?!\\w)",
	].join("|"),
	"g",
);
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function inlines(text: string): Inline[] {
	const result: Inline[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		if (match.index > last) result.push({ type: "text", text: text.slice(last, match.index) });
		const [, bold, source, id, starItalic, underscoreItalic] = match;
		// Parsed again for the citations and italics inside it. It can't hold "**", so this stops there.
		if (bold !== undefined) result.push({ type: "bold", inlines: inlines(bold) });
		else if (source !== undefined) result.push({ type: "citation", source, id });
		else result.push({ type: "italic", text: starItalic ?? underscoreItalic });
		last = match.index + match[0].length;
	}
	if (last < text.length) result.push({ type: "text", text: text.slice(last) });
	return result;
}

/**
 * An answer's text as blocks: paragraphs, headings, bullet ("- ", "* ", "• ") and numbered lists,
 * with bold, italic and [source:id] citations inline. The prompt asks for less, but the model
 * doesn't always comply, so this reads what it actually writes; anything else (a table) stays text.
 * The panel builds React elements from these, never HTML, since model output is untrusted.
 */
export function parseAnswer(text: string): Block[] {
	const blocks: Block[] = [];
	for (const line of text.split("\n")) {
		const current = blocks.at(-1);
		const item = BULLET.exec(line) ?? NUMBERED.exec(line);
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ type: "heading", inlines: inlines(heading[1].trim()) });
		} else if (item) {
			const ordered = !BULLET.test(line);
			if (current?.type === "list" && current.ordered === ordered) current.items.push(inlines(item[1]));
			else blocks.push({ type: "list", ordered, items: [inlines(item[1])] });
		} else if (line.trim() === "") {
			// A blank line ends a paragraph; an empty one marks that the next line starts a new block.
			if (current?.type === "paragraph" && current.inlines.length) blocks.push({ type: "paragraph", inlines: [] });
		} else if (current?.type === "paragraph") {
			if (current.inlines.length) current.inlines.push({ type: "text", text: " " });
			current.inlines.push(...inlines(line.trim()));
		} else {
			blocks.push({ type: "paragraph", inlines: inlines(line.trim()) });
		}
	}
	return blocks.filter((block) => block.type === "list" || block.inlines.length);
}
