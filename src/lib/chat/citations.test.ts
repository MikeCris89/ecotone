import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/agent/contract";
import { citeAnswer } from "@/lib/chat/citations";

function evidence(source: Evidence["source"], id: string): Evidence {
	return {
		source,
		id,
		url: `https://example.com/${id}`,
		label: id,
		longitude: -120,
		latitude: 37,
		observedAt: "2026-09-30T21:00:00.000Z",
		retrievedAt: "2026-09-30T21:20:00.000Z",
		license: null,
		attribution: "test",
	};
}

const OBSERVATION = evidence("inaturalist", "102");
const DETECTION = evidence("firms", "snpp:2026-09-29T10:00:00.000Z:37.1,-120.2");
const WEATHER = evidence("open-meteo", "93:2026-09-30T21:00:00.000Z");
const EVIDENCE = [OBSERVATION, DETECTION, WEATHER];

describe("citeAnswer", () => {
	it("keeps citations a tool returned, numbered by first use, and removes the rest", () => {
		const text = "A jay [inaturalist:102], an invented record [inaturalist:999] and a detection [firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2].";
		expect(citeAnswer([text], EVIDENCE)).toEqual({
			texts: ["A jay [inaturalist:102], an invented record and a detection [firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2]."],
			cited: [OBSERVATION, DETECTION],
			unmatched: 1,
		});
	});

	it("splits a weather ID at the first colon: the source before, the whole ID after", () => {
		const { texts, cited, unmatched } = citeAnswer(["Driest at 2 PM [open-meteo:93:2026-09-30T21:00:00.000Z]."], EVIDENCE);
		expect(texts).toEqual(["Driest at 2 PM [open-meteo:93:2026-09-30T21:00:00.000Z]."]);
		expect(cited).toEqual([WEATHER]);
		expect(unmatched).toBe(0);
		// The same point at another hour is a different reading.
		expect(citeAnswer(["[open-meteo:93:2026-09-30T20:00:00.000Z]"], EVIDENCE).unmatched).toBe(1);
	});

	it("gives a record cited twice one number, and counts an unmatched ID used twice once", () => {
		const text = "[firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2] then [inaturalist:102], [firms:snpp:2026-09-29T10:00:00.000Z:37.1,-120.2] again. [firms:bad] and [firms:bad].";
		const { cited, unmatched } = citeAnswer([text], EVIDENCE);
		expect(cited).toEqual([DETECTION, OBSERVATION]);
		expect(unmatched).toBe(1);
	});

	it("removes an unmatched citation next to punctuation without leaving a space before it", () => {
		expect(citeAnswer(["3 records [firms:bad].", "Near town [inaturalist:1], then more.", "Seen[inaturalist:1]!"], EVIDENCE).texts).toEqual([
			"3 records.",
			"Near town, then more.",
			"Seen!",
		]);
	});

	it("numbers across the answer's texts and keeps line breaks", () => {
		const { texts, cited } = citeAnswer(["First [inaturalist:102]", "Then:\n[firms:bad] - a\n- b [open-meteo:93:2026-09-30T21:00:00.000Z]"], EVIDENCE);
		expect(texts).toEqual(["First [inaturalist:102]", "Then:\n - a\n- b [open-meteo:93:2026-09-30T21:00:00.000Z]"]);
		expect(cited).toEqual([OBSERVATION, WEATHER]);
	});

	it("matches the source too, not just the ID", () => {
		expect(citeAnswer(["[firms:102]"], EVIDENCE)).toEqual({ texts: [""], cited: [], unmatched: 1 });
	});
});
