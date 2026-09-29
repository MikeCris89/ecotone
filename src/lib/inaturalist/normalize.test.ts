import { describe, expect, it } from "vitest";
import { localDate } from "@/lib/dates";
import { normalizeObservation } from "@/lib/inaturalist/normalize";
import { rawObservation } from "@/lib/inaturalist/test-fixtures";

const retrievedAt = new Date("2026-09-29T00:00:00Z");

function normalizedRow(overrides: Record<string, unknown> = {}) {
	const result = normalizeObservation(rawObservation(overrides), retrievedAt);
	if (result.status !== "ok") throw new Error(`Expected a row, got ${result.status}`);
	return result.row;
}

describe("normalizeObservation", () => {
	it("maps a complete record, keeping the observed, uploaded, and retrieved times separate", () => {
		expect(normalizedRow()).toEqual({
			inat_id: 404330665,
			uuid: "fe4ecd69-138b-4a91-9c33-278bfbf0227b",
			observed_on: "2026-09-24",
			observed_at: "2026-09-24T16:46:00.000Z",
			uploaded_at: "2026-09-28T23:55:42.000Z",
			source_updated_at: "2026-09-28T23:55:42.000Z",
			retrieved_at: "2026-09-29T00:00:00.000Z",
			longitude: -122.1060815,
			latitude: 38.4001881,
			positional_accuracy_m: 190,
			obscured: false,
			geoprivacy: null,
			quality_grade: "needs_id",
			taxon_id: 68138,
			scientific_name: "Sympetrum corruptum",
			common_name: "Variegated Meadowhawk",
			taxon_rank: "species",
			iconic_taxon: "Insecta",
			establishment_means: "native",
			source_url: "https://www.inaturalist.org/observations/404330665",
			license_code: "cc-by-nc",
			observer_login: "napabirder",
			photo_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/742506936/square.jpg",
			photo_license: "cc-by-nc",
		});
	});

	it("keeps the observer's local date when the UTC time falls on the next day", () => {
		const row = normalizedRow({ observed_on: "2026-09-24", time_observed_at: "2026-09-24T22:30:00-07:00" });
		expect(row.observed_on).toBe("2026-09-24");
		expect(row.observed_at).toBe("2026-09-25T05:30:00.000Z");
	});

	it("leaves observed_at null when only a date was recorded, rather than defaulting to midnight", () => {
		const row = normalizedRow({ time_observed_at: null });
		expect(row.observed_on).toBe("2026-09-24");
		expect(row.observed_at).toBeNull();
	});

	it("treats missing positional accuracy as unknown, not zero", () => {
		expect(normalizedRow({ public_positional_accuracy: null }).positional_accuracy_m).toBeNull();
		expect(normalizedRow({ public_positional_accuracy: undefined }).positional_accuracy_m).toBeNull();
		expect(normalizedRow({ public_positional_accuracy: 0 }).positional_accuracy_m).toBe(0);
	});

	it("keeps obscured coordinates flagged", () => {
		const row = normalizedRow({ obscured: true, geoprivacy: "obscured", public_positional_accuracy: 28_000 });
		expect(row).toMatchObject({ obscured: true, geoprivacy: "obscured", positional_accuracy_m: 28_000 });
	});

	it("maps establishment flags, with no listing meaning unknown rather than native", () => {
		const withFlags = (flags: Record<string, boolean | undefined>) =>
			normalizedRow({ taxon: { ...rawObservation().taxon, ...flags } }).establishment_means;

		expect(withFlags({ introduced: true, native: false })).toBe("introduced");
		expect(withFlags({ endemic: true, native: true })).toBe("endemic");
		expect(withFlags({ native: false, introduced: false, endemic: false })).toBeNull();
		expect(withFlags({ native: undefined, introduced: undefined, endemic: undefined })).toBeNull();
	});

	it("excludes well-formed records that can't be stored honestly", () => {
		const status = (overrides: Record<string, unknown>) =>
			normalizeObservation(rawObservation(overrides), retrievedAt).status;

		expect(status({ observed_on: null })).toBe("excluded");
		expect(status({ geojson: null })).toBe("excluded");
		expect(status({ taxon: null })).toBe("excluded");
	});

	it("reports records that don't match the expected shape as invalid", () => {
		const status = (overrides: Record<string, unknown>) =>
			normalizeObservation(rawObservation(overrides), retrievedAt).status;

		expect(status({ quality_grade: "unknown" })).toBe("invalid");
		expect(status({ geojson: { type: "Point", coordinates: [200, 38] } })).toBe("invalid");
		expect(normalizeObservation("not an observation", retrievedAt).status).toBe("invalid");
	});
});

describe("localDate", () => {
	it("returns the calendar date in the given timezone", () => {
		// 05:30 UTC on the 29th is still the evening of the 28th in California.
		expect(localDate(new Date("2026-09-29T05:30:00Z"), "America/Los_Angeles")).toBe("2026-09-28");
		expect(localDate(new Date("2026-09-29T08:00:00Z"), "America/Los_Angeles")).toBe("2026-09-29");
	});
});
