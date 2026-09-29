import { z } from "zod";

// Empty strings must fail rather than coerce to 0: a missing value is unknown, not zero.
const decimal = z
	.string()
	.regex(/^-?\d+(\.\d+)?$/)
	.transform(Number);
// Mirrors the table's checks: rows are upserted in one statement, so a row the database rejects
// would fail the whole response rather than just itself.
const positiveDecimal = decimal.pipe(z.number().positive());

const SATELLITES = { N: "snpp", N20: "noaa20", N21: "noaa21" } as const;
const CONFIDENCE = { l: "low", n: "nominal", h: "high" } as const;

// Live polling and historical imports both go through this. Every CSV field is a string.
const detectionSchema = z.object({
	// Kept as FIRMS formats them for the source ID; parsed separately for the location.
	latitude: z.string().regex(/^-?\d+(\.\d+)?$/),
	longitude: z.string().regex(/^-?\d+(\.\d+)?$/),
	acq_date: z.iso.date(),
	// HHMM in UTC without leading zeros: 00:05 is "5", 09:41 is "941".
	acq_time: z.string().regex(/^\d{1,4}$/),
	satellite: z.enum(["N", "N20", "N21"]),
	instrument: z.literal("VIIRS"),
	confidence: z.enum(["l", "n", "h"]),
	version: z.string().min(1),
	bright_ti4: decimal,
	bright_ti5: decimal,
	frp: decimal,
	scan: positiveDecimal,
	track: positiveDecimal,
	daynight: z.enum(["D", "N"]),
	// Standard product only.
	type: z.enum(["0", "1", "2", "3"]).optional(),
});

// Mirrors the firms_detections columns, with the point split into longitude/latitude.
// first_retrieved_at is set by the database on insert.
export type FirmsDetectionRow = {
	source_id: string;
	satellite: "snpp" | "noaa20" | "noaa21";
	product: string;
	version: string;
	acquired_at: string;
	daynight: "day" | "night";
	retrieved_at: string;
	longitude: number;
	latitude: number;
	scan_km: number;
	track_km: number;
	confidence: "low" | "nominal" | "high";
	frp_mw: number;
	bright_ti4_k: number;
	bright_ti5_k: number;
	fire_type: number | null;
	source_url: string;
};

export type NormalizeResult =
	| { status: "ok"; row: FirmsDetectionRow }
	// Well-formed, but not stored (a provisional real-time detection). A filter, not a failure.
	| { status: "excluded" }
	// Doesn't match the expected shape. A failure the run must report as incomplete.
	| { status: "invalid" };

/** Converts one parsed FIRMS CSV row into a row. */
export function normalizeDetection(raw: unknown, product: string, retrievedAt: Date): NormalizeResult {
	const parsed = detectionSchema.safeParse(raw);
	if (!parsed.success) return { status: "invalid" };
	const d = parsed.data;

	const latitude = Number(d.latitude);
	const longitude = Number(d.longitude);
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { status: "invalid" };

	const time = d.acq_time.padStart(4, "0");
	const hours = Number(time.slice(0, 2));
	const minutes = Number(time.slice(2));
	if (hours > 23 || minutes > 59) return { status: "invalid" };
	const acquiredAt = `${d.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00.000Z`;

	// Ultra-real-time and real-time (US/Canada) detections are removed upstream once the NRT
	// version is processed, 1-3 hours later. Storing them would leave stale duplicates, since
	// nothing tells us which NRT detection replaced which, so only NRT is kept for now.
	if (/\dU?RT$/.test(d.version)) return { status: "excluded" };

	const satellite = SATELLITES[d.satellite];
	const row: FirmsDetectionRow = {
		source_id: `${satellite}:${acquiredAt}:${d.latitude},${d.longitude}`,
		satellite,
		product,
		version: d.version,
		acquired_at: acquiredAt,
		daynight: d.daynight === "D" ? "day" : "night",
		retrieved_at: retrievedAt.toISOString(),
		longitude,
		latitude,
		scan_km: d.scan,
		track_km: d.track,
		confidence: CONFIDENCE[d.confidence],
		frp_mw: d.frp,
		bright_ti4_k: d.bright_ti4,
		bright_ti5_k: d.bright_ti5,
		fire_type: d.type == null ? null : Number(d.type),
		source_url: `https://firms.modaps.eosdis.nasa.gov/map/#d:${d.acq_date};@${d.longitude},${d.latitude},14z`,
	};
	return { status: "ok", row };
}
