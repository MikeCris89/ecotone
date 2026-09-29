import { describe, expect, it } from "vitest";
import { normalizeDetection } from "@/lib/firms/normalize";
import { rawDetection } from "@/lib/firms/test-fixtures";

const retrievedAt = new Date("2026-09-29T15:00:00Z");

function normalize(overrides: Record<string, string> = {}) {
	return normalizeDetection(rawDetection(overrides), "VIIRS_NOAA20_NRT", retrievedAt);
}

function normalizedRow(overrides: Record<string, string> = {}) {
	const result = normalize(overrides);
	if (result.status !== "ok") throw new Error(`Expected a row, got ${result.status}`);
	return result.row;
}

describe("normalizeDetection", () => {
	it("maps a complete row, keeping acquisition and retrieval times separate", () => {
		expect(normalizedRow()).toEqual({
			source_id: "noaa20:2026-09-28T10:19:00.000Z:40.73764,-122.3243",
			satellite: "noaa20",
			product: "VIIRS_NOAA20_NRT",
			version: "2.0NRT",
			acquired_at: "2026-09-28T10:19:00.000Z",
			daynight: "night",
			retrieved_at: "2026-09-29T15:00:00.000Z",
			longitude: -122.3243,
			latitude: 40.73764,
			scan_km: 0.41,
			track_km: 0.37,
			confidence: "nominal",
			frp_mw: 0.67,
			bright_ti4_k: 302.48,
			bright_ti5_k: 284.93,
			fire_type: null,
			source_url: "https://firms.modaps.eosdis.nasa.gov/map/#d:2026-09-28;@-122.3243,40.73764,14z",
		});
	});

	it("reads acq_time as UTC HHMM without leading zeros", () => {
		expect(normalizedRow({ acq_time: "941" }).acquired_at).toBe("2026-09-28T09:41:00.000Z");
		expect(normalizedRow({ acq_time: "5" }).acquired_at).toBe("2026-09-28T00:05:00.000Z");
		expect(normalizedRow({ acq_time: "0" }).acquired_at).toBe("2026-09-28T00:00:00.000Z");
	});

	it("rejects times that aren't a real HHMM", () => {
		expect(normalize({ acq_time: "2460" })).toEqual({ status: "invalid" });
		expect(normalize({ acq_time: "975" })).toEqual({ status: "invalid" });
		expect(normalize({ acq_time: "12345" })).toEqual({ status: "invalid" });
	});

	it("gives the same detection the same source ID on every fetch", () => {
		const later = normalizeDetection(rawDetection(), "VIIRS_NOAA20_NRT", new Date("2026-09-29T16:00:00Z"));
		expect(later.status === "ok" && later.row.source_id).toBe(normalizedRow().source_id);
	});

	it("maps satellites and confidence levels", () => {
		expect(normalizedRow({ satellite: "N" }).satellite).toBe("snpp");
		expect(normalizedRow({ satellite: "N21" }).satellite).toBe("noaa21");
		expect(normalizedRow({ confidence: "l" }).confidence).toBe("low");
		expect(normalizedRow({ confidence: "h" }).confidence).toBe("high");
		expect(normalizedRow({ daynight: "D" }).daynight).toBe("day");
	});

	it("treats a missing measurement as invalid, never as zero", () => {
		expect(normalize({ frp: "" })).toEqual({ status: "invalid" });
		expect(normalize({ latitude: "" })).toEqual({ status: "invalid" });
	});

	it("rejects unknown codes and out-of-range coordinates", () => {
		expect(normalize({ satellite: "Terra" })).toEqual({ status: "invalid" });
		expect(normalize({ confidence: "85" })).toEqual({ status: "invalid" });
		expect(normalize({ latitude: "91.2" })).toEqual({ status: "invalid" });
	});

	it("rejects pixel sizes the table would reject, so they can't fail the whole batch", () => {
		expect(normalize({ scan: "0" })).toEqual({ status: "invalid" });
		expect(normalize({ scan: "-0.4" })).toEqual({ status: "invalid" });
		expect(normalize({ track: "0" })).toEqual({ status: "invalid" });
	});

	it("excludes provisional real-time detections, which FIRMS replaces with NRT", () => {
		expect(normalize({ version: "2.0URT" })).toEqual({ status: "excluded" });
		expect(normalize({ version: "2.0RT" })).toEqual({ status: "excluded" });
	});

	it("keeps the standard product's fire type", () => {
		const row = normalizeDetection(rawDetection({ type: "2", version: "2" }), "VIIRS_SNPP_SP", retrievedAt);
		expect(row.status === "ok" && row.row.fire_type).toBe(2);
	});
});
