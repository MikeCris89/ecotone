// Layer colours, shared by the map's paint and the legend. Aqua and orange are categorical slots
// that stay distinguishable together under colour-vision deficiency; temperature is a one-hue
// sequential ramp (light is cold, dark is warm), so it can't be mistaken for thermal detections.
export const OBSERVATION_COLOR = "#1baf7a";
export const OBSERVATION_DENSE_COLOR = "#0f6e4c";
export const DETECTION_COLOR = "#eb6834";
export const NO_VALUE_COLOR = "#c3c2b7";

// °C. Values beyond either end take the end colour.
export const TEMPERATURE_STOPS: [celsius: number, color: string][] = [
	[0, "#cde2fb"],
	[10, "#86b6ef"],
	[20, "#3987e5"],
	[30, "#1c5cab"],
	[40, "#0d366b"],
];
