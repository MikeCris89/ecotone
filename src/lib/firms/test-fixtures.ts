// A real row from the VIIRS_NOAA20_NRT Area API CSV, keyed by header.
export function rawDetection(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		latitude: "40.73764",
		longitude: "-122.3243",
		bright_ti4: "302.48",
		scan: "0.41",
		track: "0.37",
		acq_date: "2026-09-28",
		acq_time: "1019",
		satellite: "N20",
		instrument: "VIIRS",
		confidence: "n",
		version: "2.0NRT",
		bright_ti5: "284.93",
		frp: "0.67",
		daynight: "N",
		...overrides,
	};
}

export const CSV_HEADER =
	"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";

// Serializes rows the way FIRMS does: header first, no trailing newline.
export function toCsv(rows: Record<string, string>[]): string {
	const columns = CSV_HEADER.split(",");
	return [CSV_HEADER, ...rows.map((row) => columns.map((column) => row[column]).join(","))].join("\n");
}
