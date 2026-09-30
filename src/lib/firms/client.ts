import type { Bbox } from "@/lib/datasets";

const API_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const REQUEST_TIMEOUT_MS = 30_000;

// VIIRS on its three satellites, near-real-time. MODIS is left out: 1 km pixels and a 0-100
// confidence scale would need a second row shape for a coarser view of the same fires.
export const LIVE_PRODUCTS = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"] as const;
export type Product = (typeof LIVE_PRODUCTS)[number];
// Typical delay between a satellite pass and its NRT detections appearing in FIRMS. The window is
// on acquisition time, so a complete response still can't vouch for the last few hours: passes
// in them may not be published yet. Typical, not guaranteed; a slower day can exceed it.
export const NRT_LATENCY_MS = 3 * 60 * 60_000;

// Columns the normalizer reads. FIRMS may add or reorder columns, so rows are keyed by header name.
const REQUIRED_COLUMNS = [
	"latitude",
	"longitude",
	"bright_ti4",
	"scan",
	"track",
	"acq_date",
	"acq_time",
	"satellite",
	"instrument",
	"confidence",
	"version",
	"bright_ti5",
	"frp",
	"daynight",
];

export type RawDetection = Record<string, string>;

/**
 * Every detection FIRMS has for `product` in the bbox, acquired on the UTC dates
 * `from` .. `from + days - 1`. FIRMS returns the whole range at once: there's no paging.
 *
 * No retries: the next poll re-fetches the same window anyway.
 */
export async function fetchDetections(query: {
	product: Product;
	bbox: Bbox;
	// First UTC acquisition date (YYYY-MM-DD).
	from: string;
	// 1 to 5, FIRMS's limit.
	days: number;
}): Promise<RawDetection[]> {
	const mapKey = process.env.FIRMS_MAP_KEY;
	if (!mapKey) throw new Error("FIRMS_MAP_KEY is not set");

	const { west, south, east, north } = query.bbox;
	const url = `${API_URL}/${mapKey}/${query.product}/${west},${south},${east},${north}/${query.days}/${query.from}`;
	try {
		const response = await fetch(url, {
			cache: "no-store",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.text();
		// FIRMS's own errors are a short plain-text message, e.g. 400 "Invalid MAP_KEY."
		if (!response.ok) throw new Error(`FIRMS responded ${response.status}: ${body.trim().slice(0, 200)}`);
		return parseCsv(body);
	} catch (error) {
		// The key is part of the path, and a gateway error page can echo the URL back. Errors end up
		// in ingestion_runs and the cron response, so they never carry the key.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message.replaceAll(mapKey, "[MAP_KEY]"));
	}
}

/** Parses FIRMS CSV, which has a header row and no quoted fields. */
export function parseCsv(body: string): RawDetection[] {
	const [headerLine, ...lines] = body.trim().split(/\r?\n/);
	const header = headerLine.split(",");
	const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
	// Also catches a 200 whose body is a message rather than CSV.
	if (missing.length > 0) {
		throw new Error(`Unexpected FIRMS response (missing ${missing.join(", ")}): ${headerLine.slice(0, 200)}`);
	}

	return lines
		.filter((line) => line !== "")
		.map((line) => {
			const values = line.split(",");
			return Object.fromEntries(header.map((column, i) => [column, values[i] ?? ""]));
		});
}
