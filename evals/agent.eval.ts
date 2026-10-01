// Agent evals (Phase 11): questions sent to the deployed chat, each answer checked by code against
// the behaviour the prompt and tools promise. They call the real model, so they cost money (about
// $1 a run), use 12 of the reviewer bucket's questions, and land in production's chat_requests.
// Answers vary between runs: a failure prints the answer, to read before changing anything.
// Run with `pnpm eval`.
import { afterAll, describe, expect, test } from "vitest";
import type { Conditions } from "@/lib/agent/conditions";
import { LIMITATIONS } from "@/lib/agent/contract";
import type { NearDetections } from "@/lib/agent/near-detections";
import type { ChatContext } from "@/lib/chat/context";
import {
	affirmed,
	ask,
	BANNED_TERMS,
	CAUSAL_TERMS,
	contextFor,
	MAX_STEPS,
	outputsOf,
	type Reply,
	unrefused,
	VIEWS,
} from "./chat";

type Row = {
	question: string;
	steps: number;
	tools: string;
	noAnswer: boolean;
	unmatched: number;
	finish: string;
	notes: string[];
};
const rows: Row[] = [];

type Asked = Reply & { notes: string[] };

const shown = (reply: Reply) => `Answer:\n${reply.text || "(none)"}`;

/** Asks, records the reply for the summary, and runs the checks every answer must pass. */
async function asked(text: string, context: ChatContext, history: Reply | null = null): Promise<Asked> {
	const reply = await ask(text, context, history ? [history.question, history.message] : []);
	// The summary's notes: a case's own checks add to them.
	const notes: string[] = [];
	if (reply.steps >= MAX_STEPS) notes.push(`used all ${MAX_STEPS} steps`);
	for (const tool of reply.tools.filter((tool) => tool.failed)) notes.push(`${tool.name} failed`);
	// Asked for but never run: the step was cut off, or the reply ended first.
	const notRun = reply.tools.filter((tool) => !tool.output && !tool.failed).length;
	if (notRun > 0) notes.push(`${notRun} tool call${notRun === 1 ? "" : "s"} never ran`);
	rows.push({
		question: text.length > 60 ? `${text.slice(0, 57)}...` : text,
		steps: reply.steps,
		tools: reply.tools.map((tool) => tool.name).join(", "),
		noAnswer: reply.text === "",
		unmatched: reply.unmatched,
		finish: reply.finishReason ?? "unknown",
		notes,
	});

	expect.soft(reply.text, "The reply ended without an answer").not.toBe("");
	expect.soft(unrefused(reply.text, BANNED_TERMS), shown(reply)).toEqual([]);
	return { ...reply, notes };
}

const called = (reply: Reply, name: string) =>
	expect.soft(reply.tools.map((tool) => tool.name), `Expected a ${name} call`).toContain(name);

// Follow-ups reuse an earlier question's reply as their history, as the chat panel sends it.
let fireReply: Reply | null = null;
let statewideReply: Reply | null = null;

describe("agent evals", () => {
	afterAll(() => {
		console.table(rows.map((row) => ({ ...row, notes: row.notes.join("; ") })));
		const share = (n: number) => `${n} of ${rows.length}`;
		console.log(
			`No answer: ${share(rows.filter((row) => row.noAnswer).length)}. ` +
				`With citations no tool returned: ${share(rows.filter((row) => row.unmatched > 0).length)}.`,
		);
	});

	test("1. fire question leads with the largest cluster", async () => {
		const reply = await asked("What wildlife was recorded near thermal activity this week?", contextFor(VIEWS.statewide));
		fireReply = reply;
		called(reply, "observations_near_detections");
		const largest = (outputsOf(reply, "observations_near_detections")[0]?.result as NearDetections | null)?.clusters[0];
		if (!largest) return void reply.notes.push("no clusters to lead with");
		const count = largest.detections;
		expect
			.soft(
				reply.text.includes(count.toLocaleString("en-US")) || reply.text.includes(String(count)),
				`Expected the largest cluster's ${count} detections. ${shown(reply)}`,
			)
			.toBe(true);
	});

	test("2. is it a fire: no yes or no, only what it's consistent with", async () => {
		if (!fireReply) throw new Error("Needs question 1's reply");
		const reply = await asked("Is the largest cluster a fire?", contextFor(VIEWS.statewide), fireReply);
		// "No, I can't confirm that" fails too: an opening yes or no reads as a verdict.
		expect.soft(reply.text, shown(reply)).not.toMatch(/^\W*(yes|no)\b/i);
		expect
			.soft(
				affirmed(reply.text, /\b(is|was|likely|probably|definitely|clearly)\s+(an?\s+)?(active\s+)?(wild|vegetation\s+)?fire\b/i),
				shown(reply),
			)
			.toEqual([]);
		// The prompt's wording or an equivalent: "fits the pattern of a vegetation fire" says the same.
		expect.soft(reply.text, shown(reply)).toMatch(/consistent with|fits? the pattern|\bmatch(es)?\b/i);
	});

	test("3. freshness question checks data status", async () => {
		const reply = await asked("How fresh is the data?", contextFor(VIEWS.statewide));
		called(reply, "get_data_status");
	});

	test("4. weather right now states the grid distance, and an old reading's age", async () => {
		const reply = await asked("What are the conditions right now here?", contextFor(VIEWS.sacramento, "24h"));
		called(reply, "get_conditions");
		expect.soft(reply.text, shown(reply)).toMatch(/\d+(\.\d+)?\s*(km|kilomet)/i);
		const fallback = (outputsOf(reply, "get_conditions")[0]?.result as Conditions | null)?.fallback;
		if (!fallback) return void reply.notes.push("fallback not exercised (readings in range)");
		reply.notes.push(`fallback ${fallback.current ? "current" : "stale"}, ${fallback.ageHours} h old`);
		expect.soft(reply.text, `Expected the reading's age. ${shown(reply)}`).toMatch(/\b\d+(\.\d+)?\s*(h|hrs?|hours?|min|minutes?)\b/i);
		if (!fallback.current) {
			expect
				.soft(reply.text, `Expected "last available". ${shown(reply)}`)
				.toMatch(/\b(last|latest|most recent|newest) (available|reading)/i);
		}
	});

	test("5. species question says recorded observations and that recent ones are still arriving", async () => {
		const reply = await asked("What species were recorded here in the last 24 hours?", contextFor(VIEWS.bayArea, "24h"));
		called(reply, "summarize_observations");
		expect.soft(reply.text, shown(reply)).toMatch(/recorded observation/i);
		expect.soft(reply.text, shown(reply)).toMatch(/still (arriving|coming in|being uploaded)|undercount|upload/i);
	});

	test("6. period comparison uses compare_periods and claims no significance", async () => {
		const reply = await asked(
			"Did recorded observations here change between the first and second half of this week?",
			contextFor(VIEWS.bayArea),
		);
		called(reply, "compare_periods");
		expect.soft(affirmed(reply.text, /\bsignifican/i), shown(reply)).toEqual([]);
	});

	test("7. population and causation question is refused", async () => {
		const reply = await asked("Did the fires this week reduce the deer population?", contextFor(VIEWS.statewide));
		expect
			.soft(unrefused(reply.text, CAUSAL_TERMS), shown(reply))
			.toEqual([]);
	});

	test("8. a view outside the state (Reno) is answered as outside California, not zero", async () => {
		const reply = await asked("How many recorded observations were there here this week?", contextFor(VIEWS.reno));
		expect.soft(reply.text, shown(reply)).toMatch(/outside (of )?California|only covers California/i);
		expect.soft(reply.text, shown(reply)).not.toMatch(/\b(0|zero|no) recorded observations\b|\bnone were recorded\b/i);
	});

	test("9. a statewide answer has no 'extends beyond California' limitation", async () => {
		const reply = await asked("How many recorded observations were there across California this week?", contextFor(VIEWS.statewide));
		statewideReply = reply;
		called(reply, "summarize_observations");
		const limitations = reply.tools.flatMap((tool) => tool.output?.limitations ?? []);
		expect.soft(limitations).not.toContain(LIMITATIONS.beyondCalifornia);
	});

	test("10. after a map move, the earlier answer isn't retracted", async () => {
		if (!statewideReply) throw new Error("Needs question 9's reply");
		const reply = await asked("How many were recorded here?", contextFor(VIEWS.bayArea), statewideReply);
		expect
			.soft(
				affirmed(reply.text, /\b(I was wrong|was (incorrect|wrong|mistaken)|correction|my (mistake|error)|apologi[sz]e|misspoke)\b/i),
				shown(reply),
			)
			.toEqual([]);
	});

	test("11. offers no action the tools can't do now", async () => {
		const reply = await asked("Can you let me know when new thermal detections appear?", contextFor(VIEWS.statewide, "24h"));
		expect
			.soft(
				affirmed(
					reply.text,
					/\b(I('ll| will| can| could)|let me)\b.*\b(later|in the future|periodically|monitor|keep an eye|notify|alert|let you know when|check back)\b/i,
				),
				shown(reply),
			)
			.toEqual([]);
	});

	test("12. a question needing every step still ends with an answer", async () => {
		const reply = await asked(
			"For each of the 5 largest thermal detection clusters this week, one at a time: give the modeled conditions at its " +
				"centre, then the recorded observations within 10 km and 48 hours of it, then compare recorded observations in a " +
				"20 km box around it between the first and second half of the week.",
			contextFor(VIEWS.statewide),
		);
		// This one is meant to reach the limit: that's when the last-step instruction is tested. Known to fail
		// for now: the model asks for every tool in step 2, and they outlast the route's 120 s maxDuration
		// before it can answer (roadmap, Phase 11).
		if (reply.steps < MAX_STEPS) reply.notes.push("step limit not reached: the last-step instruction wasn't tested");
	});
});
