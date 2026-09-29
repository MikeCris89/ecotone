import { z } from "zod";

// Also the order of the map rows' quality-grade index (see map.ts).
export const QUALITY_GRADES = ["research", "needs_id", "casual"] as const;

// Only the fields we store; Zod drops the rest. Live polling and backfill both go through this.
const observationSchema = z.object({
	id: z.number().int().positive(),
	// Any 8-4-4-4-12 hex string: older iNaturalist UUIDs may not carry RFC version bits.
	uuid: z.guid(),
	observed_on: z.iso.date().nullish(),
	time_observed_at: z.iso.datetime({ offset: true }).nullish(),
	created_at: z.iso.datetime({ offset: true }),
	updated_at: z.iso.datetime({ offset: true }),
	// Null when geoprivacy is private: there are no public coordinates.
	geojson: z
		.object({
			type: z.literal("Point"),
			coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
		})
		.nullish(),
	public_positional_accuracy: z.number().nonnegative().nullish(),
	obscured: z.boolean(),
	geoprivacy: z.enum(["open", "obscured", "private"]).nullish(),
	quality_grade: z.enum(QUALITY_GRADES),
	taxon: z
		.object({
			id: z.number().int().positive(),
			name: z.string(),
			rank: z.string(),
			preferred_common_name: z.string().nullish(),
			iconic_taxon_name: z.string().nullish(),
			introduced: z.boolean().nullish(),
			endemic: z.boolean().nullish(),
			native: z.boolean().nullish(),
		})
		.nullish(),
	license_code: z.string().nullish(),
	user: z.object({ login: z.string() }),
	photos: z.array(z.object({ url: z.url(), license_code: z.string().nullish() })).nullish(),
});

// Mirrors the inat_observations columns, with the point split into longitude/latitude.
export type InatObservationRow = {
	inat_id: number;
	uuid: string;
	observed_on: string;
	observed_at: string | null;
	uploaded_at: string;
	source_updated_at: string;
	retrieved_at: string;
	longitude: number;
	latitude: number;
	positional_accuracy_m: number | null;
	obscured: boolean;
	geoprivacy: "open" | "obscured" | "private" | null;
	quality_grade: (typeof QUALITY_GRADES)[number];
	taxon_id: number;
	scientific_name: string;
	common_name: string | null;
	taxon_rank: string;
	iconic_taxon: string | null;
	establishment_means: "introduced" | "endemic" | "native" | null;
	source_url: string;
	license_code: string | null;
	observer_login: string;
	photo_url: string | null;
	photo_license: string | null;
};

export type NormalizeResult =
	| { status: "ok"; row: InatObservationRow }
	// Well-formed, but can't be stored honestly (no date, no public coordinates, no taxon).
	// A filter, not a failure.
	| { status: "excluded" }
	// Doesn't match the expected shape. A failure the run must report as incomplete.
	| { status: "invalid" };

/** Converts one raw iNaturalist API observation into a row. */
export function normalizeObservation(raw: unknown, retrievedAt: Date): NormalizeResult {
	const parsed = observationSchema.safeParse(raw);
	if (!parsed.success) return { status: "invalid" };
	const obs = parsed.data;
	if (!obs.observed_on || !obs.geojson || !obs.taxon) return { status: "excluded" };

	const [longitude, latitude] = obs.geojson.coordinates;
	const photo = obs.photos?.[0];

	const row: InatObservationRow = {
		inat_id: obs.id,
		uuid: obs.uuid,
		// The observer's local date, kept as-is. observed_at stays null when no time was recorded.
		observed_on: obs.observed_on,
		observed_at: obs.time_observed_at ? toUtcIso(obs.time_observed_at) : null,
		uploaded_at: toUtcIso(obs.created_at),
		source_updated_at: toUtcIso(obs.updated_at),
		retrieved_at: retrievedAt.toISOString(),
		longitude,
		latitude,
		positional_accuracy_m:
			obs.public_positional_accuracy == null ? null : Math.round(obs.public_positional_accuracy),
		obscured: obs.obscured,
		geoprivacy: obs.geoprivacy ?? null,
		quality_grade: obs.quality_grade,
		taxon_id: obs.taxon.id,
		scientific_name: obs.taxon.name,
		common_name: obs.taxon.preferred_common_name ?? null,
		taxon_rank: obs.taxon.rank,
		iconic_taxon: obs.taxon.iconic_taxon_name ?? null,
		establishment_means: establishmentMeans(obs.taxon),
		source_url: `https://www.inaturalist.org/observations/${obs.id}`,
		license_code: obs.license_code ?? null,
		observer_login: obs.user.login,
		photo_url: photo?.url ?? null,
		photo_license: photo?.license_code ?? null,
	};
	return { status: "ok", row };
}

// iNaturalist derives these flags from its checklists for places containing the observation.
// All false or missing means no listing, which is unknown, not native.
function establishmentMeans(taxon: {
	introduced?: boolean | null;
	endemic?: boolean | null;
	native?: boolean | null;
}): InatObservationRow["establishment_means"] {
	if (taxon.introduced) return "introduced";
	if (taxon.endemic) return "endemic";
	if (taxon.native) return "native";
	return null;
}

function toUtcIso(value: string): string {
	return new Date(value).toISOString();
}
