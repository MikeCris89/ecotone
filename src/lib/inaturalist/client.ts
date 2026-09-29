import { z } from "zod";
import type { Bbox } from "@/lib/datasets";

const API_URL = "https://api.inaturalist.org/v1/observations";
const USER_AGENT = "EcotoneExplorer/0.1 (+https://github.com/MikeCris89/ecotone)";
export const PER_PAGE = 200;
// Callers wait this long between pages: iNaturalist asks clients to stay under ~60 requests per minute.
export const REQUEST_INTERVAL_MS = 1_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

// Records are otherwise validated one by one in normalizeObservation, so one bad record is
// reported instead of failing the page. id and updated_at are required here because paging
// depends on them: without them a run can't tell how far it got, so the page fails.
const pageSchema = z.object({
	results: z.array(
		z.looseObject({ id: z.number().int().positive(), updated_at: z.iso.datetime({ offset: true }) }),
	),
});

export type RawObservation = z.infer<typeof pageSchema>["results"][number];

/**
 * One page of animal observations in the bbox. All quality grades are fetched: skipping casual
 * would hide a record that gets downgraded to casual, leaving a stale row behind.
 *
 * Live polling pages by update time: records updated at or after `updatedSince` (inclusive, to
 * the second), oldest update first. Backfill pages by ID: records with an ID above `idAbove`,
 * lowest first, which stays stable while records change mid-run and isn't subject to
 * iNaturalist's 10,000-result limit on page numbers.
 *
 * Throws rather than retrying or waiting past `deadline` (epoch ms), so the caller always has
 * time left to record the run's outcome before the function is killed.
 */
export async function fetchObservationsPage(
	query: {
		bbox: Bbox;
		// First local observation date to include (YYYY-MM-DD).
		observedFrom: string;
		deadline: number;
	} & (
		| { updatedSince: Date; page: number }
		// observedTo: last local observation date to include (YYYY-MM-DD).
		| { observedTo: string; idAbove: number }
	),
): Promise<RawObservation[]> {
	const params = new URLSearchParams({
		taxon_id: "1", // Animalia
		swlat: String(query.bbox.south),
		swlng: String(query.bbox.west),
		nelat: String(query.bbox.north),
		nelng: String(query.bbox.east),
		d1: query.observedFrom,
		order: "asc",
		per_page: String(PER_PAGE),
	});
	if ("idAbove" in query) {
		params.set("d2", query.observedTo);
		params.set("order_by", "id");
		params.set("id_above", String(query.idAbove));
	} else {
		params.set("updated_since", query.updatedSince.toISOString());
		params.set("order_by", "updated_at");
		params.set("page", String(query.page));
	}

	for (let attempt = 0; ; attempt++) {
		const remaining = query.deadline - Date.now();
		if (remaining <= 0) throw new Error("iNaturalist request deadline reached");

		// fetch throws on network-level failures (connection reset, DNS, timeout), which are as
		// transient as a 5xx, so they share its retry.
		let response: Response | undefined;
		let networkError: unknown;
		try {
			response = await fetch(`${API_URL}?${params}`, {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				cache: "no-store",
				signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
			});
		} catch (error) {
			networkError = error;
		}
		// Back off on rate limiting and transient upstream errors, as iNaturalist asks, but only
		// if the retry can still finish before the deadline.
		const retryDelay = RETRY_DELAY_MS * (attempt + 1);
		if (
			(!response || response.status === 429 || response.status >= 500) &&
			attempt < MAX_RETRIES &&
			Date.now() + retryDelay < query.deadline
		) {
			await sleep(retryDelay);
			continue;
		}
		if (!response) throw networkError;
		if (!response.ok) throw new Error(`iNaturalist responded ${response.status}`);
		return pageSchema.parse(await response.json()).results;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
