import { expression, featureFilter, latest } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { WIND_FILTER, WIND_LAYOUT } from "@/components/wind-icons";

function evaluateLayout(property: "icon-image" | "icon-rotate", properties: Record<string, unknown>) {
	const parsed = expression.createExpression(WIND_LAYOUT![property], latest.layout_symbol[property]);
	if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
	return parsed.value.evaluateWithoutErrorHandling({ zoom: 6 }, { type: "Point", properties });
}

function drawn(properties: Record<string, unknown>) {
	return featureFilter(WIND_FILTER).filter({ zoom: 6 }, { type: "Point", properties });
}

describe("wind layer", () => {
	it.each([
		[0, "wind-calm"],
		[5, "wind-1"],
		[12, "wind-2"],
		[29.9, "wind-2"],
		[30, "wind-3"],
		[90, "wind-3"],
	])("draws %s km/h as %s", (windKmh, image) => {
		expect(evaluateLayout("icon-image", { windKmh, windDirectionDeg: 90 }).toString()).toBe(image);
	});

	it("points the arrow where the wind blows, not where it comes from", () => {
		// A north wind (from 0°) blows south.
		expect(evaluateLayout("icon-rotate", { windKmh: 10, windDirectionDeg: 0 })).toBe(180);
		expect(evaluateLayout("icon-rotate", { windKmh: 10, windDirectionDeg: 270 })).toBe(450);
	});

	it("draws nothing for a missing speed, or a missing direction unless calm", () => {
		expect(drawn({ windKmh: null, windDirectionDeg: 90 })).toBe(false);
		expect(drawn({ windDirectionDeg: 90 })).toBe(false);
		expect(drawn({ windKmh: 10, windDirectionDeg: null })).toBe(false);
		expect(drawn({ windKmh: 1, windDirectionDeg: null })).toBe(true);
		expect(drawn({ windKmh: 10, windDirectionDeg: 90 })).toBe(true);
	});
});
