import { expression, latest } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { guardMissingNumbers } from "@/lib/basemap-style";

// Two of the filters that raise the error, as OpenFreeMap Positron has them (2026-09-29).
const BOUNDARY_FILTER = [
	"all",
	[">=", ["get", "admin_level"], 3],
	["<=", ["get", "admin_level"], 6],
	["!=", ["get", "maritime"], 1],
	["!=", ["get", "disputed"], 1],
	["!", ["has", "claimed_by"]],
];
const SHIELD_FILTER = [
	"all",
	["<=", ["get", "ref_length"], 6],
	["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
	["match", ["get", "network"], ["us-highway", "us-state"], true, false],
];

function styleWith(filters: unknown[]): StyleSpecification {
	return {
		version: 8,
		sources: {},
		layers: filters.map((filter, index) => ({ id: `layer-${index}`, type: "line", source: "x", filter })),
	} as StyleSpecification;
}

// Throws where MapLibre would log the error and drop the feature.
function keeps(filter: unknown, properties: Record<string, unknown>) {
	const parsed = expression.createExpression(filter, latest.filter);
	if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
	return parsed.value.evaluateWithoutErrorHandling({ zoom: 10 }, { type: 2, properties });
}

describe("guardMissingNumbers", () => {
	const [boundary, shield] = guardMissingNumbers(styleWith([BOUNDARY_FILTER, SHIELD_FILTER])).layers.map(
		(layer) => ("filter" in layer ? layer.filter : undefined),
	);

	it("drops features missing the compared property without an error", () => {
		expect(() => keeps(BOUNDARY_FILTER, {})).toThrow("Expected value to be of type number, but found null");
		expect(keeps(boundary, {})).toBe(false);
		expect(keeps(shield, { network: "us-state" })).toBe(false);
	});

	it.each([
		["a state boundary", BOUNDARY_FILTER, { admin_level: 4 }, true],
		["a country boundary", BOUNDARY_FILTER, { admin_level: 2 }, false],
		["a short US shield", SHIELD_FILTER, { ref_length: 3, network: "us-state" }, true],
		["a long US shield", SHIELD_FILTER, { ref_length: 9, network: "us-state" }, false],
	])("keeps the original result for %s", (_, original, properties, expected) => {
		const patched = original === BOUNDARY_FILTER ? boundary : shield;
		expect(keeps(original, properties)).toBe(expected);
		expect(keeps(patched, properties)).toBe(expected);
	});

	it("leaves filters without a numeric comparison on a property unchanged", () => {
		const filter = ["==", ["get", "class"], "motorway"];
		expect(guardMissingNumbers(styleWith([filter])).layers[0]).toMatchObject({ filter });
	});
});
