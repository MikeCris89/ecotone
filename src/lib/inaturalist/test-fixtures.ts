// Trimmed from a real /v1/observations result.
export function rawObservation(overrides: Record<string, unknown> = {}) {
	return {
		id: 404330665,
		uuid: "fe4ecd69-138b-4a91-9c33-278bfbf0227b",
		observed_on: "2026-09-24",
		time_observed_at: "2026-09-24T09:46:00-07:00",
		created_at: "2026-09-28T16:55:42-07:00",
		updated_at: "2026-09-28T16:55:42-07:00",
		geojson: { type: "Point", coordinates: [-122.1060815, 38.4001881] },
		public_positional_accuracy: 190,
		obscured: false,
		geoprivacy: null,
		quality_grade: "needs_id",
		taxon: {
			id: 68138,
			name: "Sympetrum corruptum",
			rank: "species",
			preferred_common_name: "Variegated Meadowhawk",
			iconic_taxon_name: "Insecta",
			native: true,
			introduced: false,
			endemic: false,
		},
		license_code: "cc-by-nc",
		user: { login: "napabirder" },
		photos: [
			{
				url: "https://inaturalist-open-data.s3.amazonaws.com/photos/742506936/square.jpg",
				license_code: "cc-by-nc",
			},
		],
		// Fields we don't store are ignored.
		species_guess: "Variegated Meadowhawk",
		...overrides,
	};
}
