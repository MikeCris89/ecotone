import { describe, expect, it } from "vitest";
import { nextDate, startOfLocalDate } from "@/lib/dates";

const LA = "America/Los_Angeles";

describe("startOfLocalDate", () => {
	it("starts a Pacific date at 07:00 UTC in daylight time and 08:00 UTC in standard time", () => {
		expect(startOfLocalDate("2026-09-29", LA).toISOString()).toBe("2026-09-29T07:00:00.000Z");
		expect(startOfLocalDate("2026-12-01", LA).toISOString()).toBe("2026-12-01T08:00:00.000Z");
	});

	it("uses the offset in force at local midnight on the days clocks change", () => {
		// Clocks change at 02:00 local, so both midnights keep the previous day's offset.
		expect(startOfLocalDate("2026-03-08", LA).toISOString()).toBe("2026-03-08T08:00:00.000Z");
		expect(startOfLocalDate("2026-11-01", LA).toISOString()).toBe("2026-11-01T07:00:00.000Z");
	});

	it("handles UTC and zones ahead of it", () => {
		expect(startOfLocalDate("2026-09-29", "UTC").toISOString()).toBe("2026-09-29T00:00:00.000Z");
		expect(startOfLocalDate("2026-09-29", "Asia/Tokyo").toISOString()).toBe("2026-09-28T15:00:00.000Z");
	});
});

describe("nextDate", () => {
	it("rolls over months and years", () => {
		expect(nextDate("2026-09-30")).toBe("2026-10-01");
		expect(nextDate("2026-12-31")).toBe("2027-01-01");
	});
});
