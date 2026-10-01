import type { CircleLayerSpecification } from "maplibre-gl";
import type { WeatherProperties } from "@/lib/map-layers";

// Layer colours, shared by the map's paint and the legend. Aqua and orange are categorical slots
// that stay distinguishable together under colour-vision deficiency. Temperature runs blue (cold)
// to purple (warm), lightness falling evenly so it reads as ordered, and keeps clear of the
// thermal detections' orange.
export const OBSERVATION_COLOR = "#1baf7a";
export const OBSERVATION_DENSE_COLOR = "#0f6e4c";
export const DETECTION_COLOR = "#eb6834";
export const NO_VALUE_COLOR = "#c3c2b7";

type Stops = [value: number, color: string][];
type CircleColor = NonNullable<CircleLayerSpecification["paint"]>["circle-color"];

// Values beyond either end take the end colour. °C.
const TEMPERATURE_STOPS: Stops = [
	[0, "#86b6ef"],
	[10, "#6d8fe0"],
	[20, "#7a6bd0"],
	[30, "#7b45b5"],
	[40, "#5e1a8c"],
];
// %. Dry is brown, humid is blue: low humidity is the fire-relevant end.
const HUMIDITY_STOPS: Stops = [
	[10, "#a0581c"],
	[30, "#d4a35f"],
	[50, "#9cc3a4"],
	[70, "#4f97b5"],
	[90, "#24577f"],
];
// km/h. Magenta, clear of the detections' orange and the observations' green.
const GUST_STOPS: Stops = [
	[0, "#f3d3e6"],
	[20, "#e3a0c6"],
	[40, "#cc5f9c"],
	[60, "#a12d6b"],
	[80, "#661043"],
];

/** Circle colour along a scale. No model value (null or missing) gets NO_VALUE_COLOR, never a scale colour. */
function scaleColor(property: keyof WeatherProperties, stops: Stops): CircleColor {
	return ["case", ["==", ["get", property], null], NO_VALUE_COLOR, ["interpolate", ["linear"], ["get", property], ...stops.flat()]];
}

function scale(label: string, unit: string, property: keyof WeatherProperties, stops: Stops) {
	return { label, unit, property, stops, color: scaleColor(property, stops) };
}

/** The variables the weather points can be coloured by, with their scale for the map and the legend. */
export const WEATHER_COLORS = {
	gusts: scale("Gusts", "km/h", "gustsKmh", GUST_STOPS),
	humidity: scale("Humidity", "%", "humidityPct", HUMIDITY_STOPS),
	temperature: scale("Temperature", "°C", "temperatureC", TEMPERATURE_STOPS),
};
export type WeatherColor = keyof typeof WEATHER_COLORS;
