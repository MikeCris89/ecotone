import type { CircleLayerSpecification } from "maplibre-gl";

// Layer colours, shared by the map's paint and the legend. Aqua and orange are categorical slots
// that stay distinguishable together under colour-vision deficiency. Temperature runs blue (cold)
// to purple (warm), lightness falling evenly so it reads as ordered, and keeps clear of the
// thermal detections' orange.
export const OBSERVATION_COLOR = "#1baf7a";
export const OBSERVATION_DENSE_COLOR = "#0f6e4c";
export const DETECTION_COLOR = "#eb6834";
export const NO_VALUE_COLOR = "#c3c2b7";

// °C. Values beyond either end take the end colour.
export const TEMPERATURE_STOPS: [celsius: number, color: string][] = [
	[0, "#86b6ef"],
	[10, "#6d8fe0"],
	[20, "#7a6bd0"],
	[30, "#7b45b5"],
	[40, "#5e1a8c"],
];

/** Circle colour by temperature. No model value (null or missing) gets NO_VALUE_COLOR, never a scale colour. */
export const TEMPERATURE_COLOR: NonNullable<CircleLayerSpecification["paint"]>["circle-color"] = [
	"case",
	["==", ["get", "temperatureC"], null],
	NO_VALUE_COLOR,
	["interpolate", ["linear"], ["get", "temperatureC"], ...TEMPERATURE_STOPS.flat()],
];
