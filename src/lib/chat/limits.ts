// Chat rate limits and the usage log, in one table (chat_requests). Every message costs money and
// the URL is public, so each bucket has a per-IP hourly limit and a daily cap: per-IP alone doesn't
// bound spend when IPs rotate. Counters live in Postgres because serverless instances share no memory.
import type postgres from "postgres";
import { z } from "zod";
import type { Bucket } from "@/lib/chat/access";
import { localDate, nextDate, startOfLocalDate } from "@/lib/dates";
import { sql } from "@/lib/db";
import { CALIFORNIA_TIME_ZONE } from "@/lib/timeline";

const HOUR_MS = 60 * 60_000;

const count = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const envSchema = z.object({
	CHAT_PUBLIC_HOURLY_PER_IP: count(5),
	CHAT_PUBLIC_DAILY: count(30),
	CHAT_REVIEWER_HOURLY_PER_IP: count(60),
	CHAT_REVIEWER_DAILY: count(300),
});

export type Limits = { hourlyPerIp: number; daily: number };

/** Each bucket's limits, from env vars so they can be tuned once real costs are known. */
export function chatLimits(env: Record<string, string | undefined> = process.env): Record<Bucket, Limits> {
	const parsed = envSchema.parse(env);
	return {
		public: { hourlyPerIp: parsed.CHAT_PUBLIC_HOURLY_PER_IP, daily: parsed.CHAT_PUBLIC_DAILY },
		reviewer: { hourlyPerIp: parsed.CHAT_REVIEWER_HOURLY_PER_IP, daily: parsed.CHAT_REVIEWER_DAILY },
	};
}

export type Admission =
	| { ok: true; id: string }
	// retryAt: when the limit next lets a request through.
	| { ok: false; limit: "hourly" | "daily"; retryAt: Date };

type Served = { daily: number; hourly: number; oldestInHour: Date | null };

/**
 * A bucket's served requests since midnight PT, and one IP's in the last hour (with its oldest, for
 * when the hourly limit lifts). No upper time bound: a request reads `now` before waiting for the
 * lock, so a row admitted while it waited can be dated after its `now`, and must still count.
 */
async function servedCounts(db: postgres.ISql, bucket: Bucket, ipHash: string, now: Date): Promise<Served> {
	const dayStart = startOfLocalDate(localDate(now, CALIFORNIA_TIME_ZONE), CALIFORNIA_TIME_ZONE);
	const hourAgo = new Date(now.getTime() - HOUR_MS);
	const [served] = await db<Served[]>`
		select
			(count(*) filter (where created_at >= ${dayStart}))::int as daily,
			(count(*) filter (where ip_hash = ${ipHash} and created_at > ${hourAgo}))::int as hourly,
			min(created_at) filter (where ip_hash = ${ipHash} and created_at > ${hourAgo}) as "oldestInHour"
		from chat_requests
		where bucket = ${bucket} and limited is null
			and created_at >= ${new Date(Math.min(dayStart.getTime(), hourAgo.getTime()))}
	`;
	return served;
}

/**
 * Records the request, turned away if a limit is reached. Checking and recording run under one
 * lock per bucket, so two simultaneous requests can't both take the last slot. Turned-away
 * requests are logged but don't count, so retrying doesn't push the reset further out.
 */
export async function admitRequest(
	bucket: Bucket,
	ipHash: string,
	limits: Limits,
	now = new Date(),
): Promise<Admission> {
	const today = localDate(now, CALIFORNIA_TIME_ZONE);

	return sql.begin(async (tx) => {
		// Transaction-scoped, so it works through Supabase's transaction pooler.
		await tx`select pg_advisory_xact_lock(hashtext(${`chat_requests:${bucket}`}))`;
		const served = await servedCounts(tx, bucket, ipHash, now);
		// The daily cap first: when both are reached, it's the one that lifts later.
		const refusal =
			served.daily >= limits.daily
				? ({ limit: "daily", retryAt: startOfLocalDate(nextDate(today), CALIFORNIA_TIME_ZONE) } as const)
				: served.hourly >= limits.hourlyPerIp
					? ({ limit: "hourly", retryAt: new Date(served.oldestInHour!.getTime() + HOUR_MS) } as const)
					: null;
		const [{ id }] = await tx<{ id: string }[]>`
			insert into chat_requests (created_at, bucket, ip_hash, limited)
			values (${now}, ${bucket}, ${ipHash}, ${refusal?.limit ?? null})
			returning id
		`;
		return refusal ? { ok: false, ...refusal } : { ok: true, id };
	});
}

/** How many more questions a bucket and IP can ask now: within the hourly and daily limits. */
export async function remainingQuota(
	bucket: Bucket,
	ipHash: string,
	limits: Limits,
	now = new Date(),
): Promise<{ hourly: number; daily: number }> {
	const served = await servedCounts(sql, bucket, ipHash, now);
	return {
		hourly: Math.max(0, limits.hourlyPerIp - served.hourly),
		daily: Math.max(0, limits.daily - served.daily),
	};
}

export type Usage = {
	durationMs: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	steps: number;
	// Null when the reply was cut off or failed.
	noAnswer: boolean | null;
};

/** Fills in what a served request cost, once its reply has finished. */
export async function recordUsage(id: string, usage: Usage, now = new Date()) {
	await sql`
		update chat_requests set
			finished_at = ${now},
			duration_ms = ${usage.durationMs},
			input_tokens = ${usage.inputTokens},
			output_tokens = ${usage.outputTokens},
			cache_read_tokens = ${usage.cacheReadTokens},
			cache_write_tokens = ${usage.cacheWriteTokens},
			steps = ${usage.steps},
			no_answer = ${usage.noAnswer}
		where id = ${id}
	`;
}
