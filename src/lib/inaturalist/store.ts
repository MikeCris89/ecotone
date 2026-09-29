import { sql } from "@/lib/db";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";

/**
 * Inserts new observations and overwrites existing ones with their latest upstream state.
 * Safe to re-run with the same rows.
 */
export async function upsertObservations(
	rows: InatObservationRow[],
	ingestionRunId: string,
): Promise<{ inserted: number; updated: number }> {
	if (rows.length === 0) return { inserted: 0, updated: 0 };

	// One statement per page: the rows travel as a single JSON parameter and are unpacked
	// server-side, instead of one round trip per row.
	const result = await sql<{ inserted: boolean }[]>`
		insert into inat_observations (
			inat_id, uuid, observed_on, observed_at, uploaded_at, source_updated_at, retrieved_at,
			location, positional_accuracy_m, obscured, geoprivacy, quality_grade,
			taxon_id, scientific_name, common_name, taxon_rank, iconic_taxon, establishment_means,
			source_url, license_code, observer_login, photo_url, photo_license, ingestion_run_id
		)
		select
			r.inat_id, r.uuid, r.observed_on, r.observed_at, r.uploaded_at, r.source_updated_at, r.retrieved_at,
			extensions.st_setsrid(extensions.st_makepoint(r.longitude, r.latitude), 4326)::extensions.geography,
			r.positional_accuracy_m, r.obscured, r.geoprivacy, r.quality_grade,
			r.taxon_id, r.scientific_name, r.common_name, r.taxon_rank, r.iconic_taxon, r.establishment_means,
			r.source_url, r.license_code, r.observer_login, r.photo_url, r.photo_license, ${ingestionRunId}::bigint
		from jsonb_to_recordset(${sql.json(rows)}::jsonb) as r (
			inat_id bigint, uuid uuid, observed_on date, observed_at timestamptz,
			uploaded_at timestamptz, source_updated_at timestamptz, retrieved_at timestamptz,
			longitude double precision, latitude double precision,
			positional_accuracy_m integer, obscured boolean, geoprivacy text, quality_grade text,
			taxon_id integer, scientific_name text, common_name text, taxon_rank text,
			iconic_taxon text, establishment_means text,
			source_url text, license_code text, observer_login text, photo_url text, photo_license text
		)
		on conflict (inat_id) do update set
			uuid = excluded.uuid,
			observed_on = excluded.observed_on,
			observed_at = excluded.observed_at,
			uploaded_at = excluded.uploaded_at,
			source_updated_at = excluded.source_updated_at,
			retrieved_at = excluded.retrieved_at,
			location = excluded.location,
			positional_accuracy_m = excluded.positional_accuracy_m,
			obscured = excluded.obscured,
			geoprivacy = excluded.geoprivacy,
			quality_grade = excluded.quality_grade,
			taxon_id = excluded.taxon_id,
			scientific_name = excluded.scientific_name,
			common_name = excluded.common_name,
			taxon_rank = excluded.taxon_rank,
			iconic_taxon = excluded.iconic_taxon,
			establishment_means = excluded.establishment_means,
			source_url = excluded.source_url,
			license_code = excluded.license_code,
			observer_login = excluded.observer_login,
			photo_url = excluded.photo_url,
			photo_license = excluded.photo_license,
			ingestion_run_id = excluded.ingestion_run_id
		-- A slower fetch that started earlier (e.g. an overlapping backfill) must not roll a record
		-- back to an older upstream state.
		where inat_observations.source_updated_at <= excluded.source_updated_at
		-- xmax is 0 only on freshly inserted rows, so this separates inserts from updates.
		returning (xmax = 0) as inserted
	`;

	const inserted = result.filter((row) => row.inserted).length;
	return { inserted, updated: result.length - inserted };
}
