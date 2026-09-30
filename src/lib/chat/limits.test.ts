// Runs against the local Supabase stack (see vitest.config.mts). Requests are dated 2101, after any
// real chat use (the counts have no upper time bound, so earlier dates would count local dev's rows),
// and their IP hashes start with "test:limits:".
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { admitRequest, chatLimits, recordUsage, remainingQuota } from "@/lib/chat/limits";
import { sql } from "@/lib/db";

const LIMITS = { hourlyPerIp: 2, daily: 3 };
// 10:00 AM PDT.
const T = Date.parse("2101-06-01T17:00:00Z");
const at = (minutes: number) => new Date(T + minutes * 60_000);
const ip = (name: string) => `test:limits:${name}`;

afterEach(async () => {
	await sql`delete from chat_requests where ip_hash like 'test:limits:%'`;
});

afterAll(async () => {
	await sql.end();
});

describe("chatLimits", () => {
	it("defaults to 5/hour and 30/day public, 60/hour and 300/day for reviewers, overridable by env", () => {
		expect(chatLimits({})).toEqual({
			public: { hourlyPerIp: 5, daily: 30 },
			reviewer: { hourlyPerIp: 60, daily: 300 },
		});
		expect(chatLimits({ CHAT_PUBLIC_DAILY: "50" }).public.daily).toBe(50);
		expect(chatLimits({ CHAT_PUBLIC_DAILY: "" }).public.daily).toBe(30);
		expect(() => chatLimits({ CHAT_REVIEWER_DAILY: "0" })).toThrow();
	});
});

describe("admitRequest", () => {
	it("counts a request admitted first even when it started later", async () => {
		const ONE_A_DAY = { hourlyPerIp: 5, daily: 1 };
		// Each request reads its clock before waiting for the lock, so the one holding the lock can
		// have started later than one still waiting. The waiting one must still see its row.
		expect(await admitRequest("public", ip("started-later"), ONE_A_DAY, at(30))).toMatchObject({ ok: true });
		expect(await admitRequest("public", ip("started-first"), ONE_A_DAY, at(0))).toMatchObject({
			ok: false,
			limit: "daily",
		});
	});

	it("limits each IP per rolling hour, until its oldest request in the hour is an hour old", async () => {
		const HOURLY = { hourlyPerIp: 2, daily: 10 };
		expect(await admitRequest("public", ip("a"), HOURLY, at(0))).toMatchObject({ ok: true });
		expect(await admitRequest("public", ip("a"), HOURLY, at(10))).toMatchObject({ ok: true });
		expect(await admitRequest("public", ip("a"), HOURLY, at(20))).toEqual({
			ok: false,
			limit: "hourly",
			retryAt: at(60),
		});
		// Another IP is unaffected, and the first is let through again after an hour.
		expect(await admitRequest("public", ip("b"), HOURLY, at(20))).toMatchObject({ ok: true });
		expect(await admitRequest("public", ip("a"), HOURLY, at(61))).toMatchObject({ ok: true });
	});

	it("caps each bucket per day across IPs, until midnight PT", async () => {
		for (const name of ["a", "b", "c"]) {
			expect(await admitRequest("public", ip(name), LIMITS, at(0))).toMatchObject({ ok: true });
		}
		expect(await admitRequest("public", ip("d"), LIMITS, at(5))).toEqual({
			ok: false,
			limit: "daily",
			retryAt: new Date("2101-06-02T07:00:00Z"),
		});
		// Past midnight PT, a new day.
		expect(await admitRequest("public", ip("d"), LIMITS, new Date("2101-06-02T07:00:00Z"))).toMatchObject({ ok: true });
	});

	it("keeps the reviewer and public counters apart", async () => {
		for (const name of ["a", "b", "c"]) await admitRequest("public", ip(name), LIMITS, at(0));
		expect(await admitRequest("public", ip("d"), LIMITS, at(1))).toMatchObject({ ok: false, limit: "daily" });
		expect(await admitRequest("reviewer", ip("d"), LIMITS, at(1))).toMatchObject({ ok: true });
	});

	it("doesn't count requests it turned away", async () => {
		await admitRequest("public", ip("a"), LIMITS, at(0));
		await admitRequest("public", ip("a"), LIMITS, at(1));
		for (const minute of [2, 3, 4]) {
			expect(await admitRequest("public", ip("a"), LIMITS, at(minute))).toMatchObject({ ok: false, limit: "hourly" });
		}
		// Only the two served requests count toward the day.
		expect(await admitRequest("public", ip("b"), LIMITS, at(5))).toMatchObject({ ok: true });
		const rows = await sql`select limited from chat_requests where ip_hash like 'test:limits:%' order by created_at`;
		expect(rows.map((row) => row.limited)).toEqual([null, null, "hourly", "hourly", "hourly", null]);
	});

	it("counts the last hour across midnight PT", async () => {
		const beforeMidnight = new Date("2101-06-02T06:50:00Z");
		await admitRequest("public", ip("a"), LIMITS, beforeMidnight);
		await admitRequest("public", ip("a"), LIMITS, new Date("2101-06-02T06:55:00Z"));
		expect(await admitRequest("public", ip("a"), LIMITS, new Date("2101-06-02T07:05:00Z"))).toMatchObject({
			ok: false,
			limit: "hourly",
		});
	});
});

describe("recordUsage", () => {
	it("fills in the request's cost once the reply finishes", async () => {
		const admission = await admitRequest("reviewer", ip("a"), LIMITS, at(0));
		if (!admission.ok) throw new Error("expected admission");
		await recordUsage(
			admission.id,
			{
				durationMs: 5200,
				inputTokens: 9000,
				outputTokens: 400,
				cacheReadTokens: 6000,
				cacheWriteTokens: null,
				steps: 3,
				noAnswer: false,
			},
			at(1),
		);

		const [row] = await sql`select * from chat_requests where id = ${admission.id}`;
		expect(row).toMatchObject({
			bucket: "reviewer",
			limited: null,
			duration_ms: 5200,
			input_tokens: 9000,
			output_tokens: 400,
			cache_read_tokens: 6000,
			cache_write_tokens: null,
			steps: 3,
			no_answer: false,
		});
		expect(row.finished_at).toEqual(at(1));
	});
});

describe("remainingQuota", () => {
	it("says how many more questions the IP can ask this hour and the bucket today, never below zero", async () => {
		await admitRequest("public", ip("a"), LIMITS, at(0));
		await admitRequest("public", ip("b"), LIMITS, at(10));
		expect(await remainingQuota("public", ip("a"), LIMITS, at(20))).toEqual({ hourly: 1, daily: 1 });
		await admitRequest("public", ip("a"), LIMITS, at(30));
		expect(await remainingQuota("public", ip("a"), LIMITS, at(40))).toEqual({ hourly: 0, daily: 0 });
		expect(await remainingQuota("reviewer", ip("a"), LIMITS, at(40))).toEqual({ hourly: 2, daily: 3 });
	});
});
