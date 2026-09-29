import { z } from "zod";
import type { Bbox } from "@/lib/datasets";

const API_URL = "https://api.inaturalist.org/v1/observations";
const USER_AGENT = "EcotoneExplorer/0.1 (+https://github.com/MikeCris89/ecotone)";
export const PER_PAGE = 200;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

// Records are otherwise validated one by one in normalizeObservation, so one bad record is
// reported instead of failing the page. updated_at is required here because paging depends on
// it: without it the poll can't tell how far it got, so the page fails.
const pageSchema = z.object({
	results: z.array(z.looseObject({ updated_at: z.iso.datetime({ offset: true }) })),
});

export type RawObservation = z.infer<typeof pageSchema>["results"][number];

/**
 * One page of animal observations in the bbox, updated at or after `updatedSince` (inclusive,
 * to the second), oldest update first. All quality grades are fetched: skipping casual would
 * hide a record that gets downgraded to casual, leaving a stale row behind.
 *
 * Throws rather than retrying or waiting past `deadline` (epoch ms), so the caller always has
 * time left to record the run's outcome before the function is killed.
 */
export async function fetchObservationsPage(query: {
	bbox: Bbox;
	updatedSince: Date;
	// First local observation date to include (YYYY-MM-DD).
	observedFrom: string;
	page: number;
	deadline: number;
}): Promise<RawObservation[]> {
	const params = new URLSearchParams({
		taxon_id: "1", // Animalia
		swlat: String(query.bbox.south),
		swlng: String(query.bbox.west),
		nelat: String(query.bbox.north),
		nelng: String(query.bbox.east),
		d1: query.observedFrom,
		updated_since: query.updatedSince.toISOString(),
		order_by: "updated_at",
		order: "asc",
		per_page: String(PER_PAGE),
		page: String(query.page),
	});

	for (let attempt = 0; ; attempt++) {
		const remaining = query.deadline - Date.now();
		if (remaining <= 0) throw new Error("iNaturalist request deadline reached");

		const response = await fetch(`${API_URL}?${params}`, {
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
			cache: "no-store",
			signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
		});
		// Back off on rate limiting and transient upstream errors, as iNaturalist asks, but only
		// if the retry can still finish before the deadline.
		const retryDelay = RETRY_DELAY_MS * (attempt + 1);
		if (
			(response.status === 429 || response.status >= 500) &&
			attempt < MAX_RETRIES &&
			Date.now() + retryDelay < query.deadline
		) {
			await sleep(retryDelay);
			continue;
		}
		if (!response.ok) throw new Error(`iNaturalist responded ${response.status}`);
		return pageSchema.parse(await response.json()).results;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
