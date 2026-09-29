import { sql } from "@/lib/db";
import type { FirmsDetectionRow } from "@/lib/firms/normalize";

/**
 * Inserts new detections and overwrites existing ones with their latest upstream state.
 * Safe to re-run with the same rows.
 */
export async function upsertDetections(
	rows: FirmsDetectionRow[],
	ingestionRunId: string,
): Promise<{ inserted: number; updated: number }> {
	if (rows.length === 0) return { inserted: 0, updated: 0 };

	// Same single-statement pattern as the iNaturalist upsert. Each poll re-fetches detections it
	// already has, so `updated` counts re-fetched rows, not upstream changes.
	const result = await sql<{ inserted: boolean }[]>`
		insert into firms_detections (
			source_id, satellite, product, version, acquired_at, daynight, first_retrieved_at, retrieved_at,
			location, scan_km, track_km, confidence, frp_mw, bright_ti4_k, bright_ti5_k, fire_type,
			source_url, ingestion_run_id
		)
		select
			r.source_id, r.satellite, r.product, r.version, r.acquired_at, r.daynight, r.retrieved_at, r.retrieved_at,
			extensions.st_setsrid(extensions.st_makepoint(r.longitude, r.latitude), 4326)::extensions.geography,
			r.scan_km, r.track_km, r.confidence, r.frp_mw, r.bright_ti4_k, r.bright_ti5_k, r.fire_type,
			r.source_url, ${ingestionRunId}::bigint
		from jsonb_to_recordset(${sql.json(rows)}::jsonb) as r (
			source_id text, satellite text, product text, version text,
			acquired_at timestamptz, daynight text, retrieved_at timestamptz,
			longitude double precision, latitude double precision,
			scan_km double precision, track_km double precision, confidence text,
			frp_mw double precision, bright_ti4_k double precision, bright_ti5_k double precision,
			fire_type smallint, source_url text
		)
		-- first_retrieved_at is deliberately not updated: it records when the detection first appeared.
		on conflict (source_id) do update set
			satellite = excluded.satellite,
			product = excluded.product,
			version = excluded.version,
			acquired_at = excluded.acquired_at,
			daynight = excluded.daynight,
			retrieved_at = excluded.retrieved_at,
			location = excluded.location,
			scan_km = excluded.scan_km,
			track_km = excluded.track_km,
			confidence = excluded.confidence,
			frp_mw = excluded.frp_mw,
			bright_ti4_k = excluded.bright_ti4_k,
			bright_ti5_k = excluded.bright_ti5_k,
			fire_type = excluded.fire_type,
			source_url = excluded.source_url,
			ingestion_run_id = excluded.ingestion_run_id
		-- xmax is 0 only on freshly inserted rows, so this separates inserts from updates.
		returning (xmax = 0) as inserted
	`;

	const inserted = result.filter((row) => row.inserted).length;
	return { inserted, updated: result.length - inserted };
}
