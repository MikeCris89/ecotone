import type { FilterSpecification, Map as MapLibreMap, SymbolLayerSpecification } from "maplibre-gl";

// Wind at each weather point: wavy streaks pointing where the wind blows, one more streak for each
// step up in speed, and a ring when it's nearly calm. Drawn as SVG once, so the map's images and
// the legend's are the same drawing.

const WIND_COLOR = "#334155";
// km/h. Below CALM_KMH the direction means little, so the point gets a ring instead of an arrow.
const CALM_KMH = 2;
// km/h: two streaks from the first step, three from the second (about Beaufort's moderate and
// strong breeze).
const STREAK_STEPS = [12, 30] as const;

// One streak on a 24-unit square: a wave from the bottom (where the wind comes from) up to a
// chevron at `top`. Side streaks start lower, so neighbouring chevrons don't merge.
function streak(x: number, top = 5) {
	const wave = Array.from({ length: 17 }, (_, i) => {
		const t = i / 16;
		return `${(x + 1.2 * Math.sin(t * 4 * Math.PI)).toFixed(2)} ${(top + 14 - t * 14).toFixed(2)}`;
	});
	return `<path d="M${wave.join(" L")} M${x - 2.5} ${top + 3} L${x} ${top} L${x + 2.5} ${top + 3}"/>`;
}

// 48 px for a 24 px icon (pixelRatio 2), dark on a white halo so it reads over any basemap or fill.
function svgUrl(shape: string) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" ` +
		`stroke-linecap="round" stroke-linejoin="round">` +
		`<g stroke="#ffffff" stroke-width="3.2">${shape}</g><g stroke="${WIND_COLOR}" stroke-width="1.5">${shape}</g></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The map's wind images, calmest first, with what each means for the legend. */
export const WIND_ICONS = [
	{ name: "wind-calm", label: `Calm, under ${CALM_KMH} km/h`, url: svgUrl(`<circle cx="12" cy="12" r="3.5"/>`) },
	{ name: "wind-1", label: `Under ${STREAK_STEPS[0]} km/h`, url: svgUrl(streak(12)) },
	{ name: "wind-2", label: `${STREAK_STEPS[0]}–${STREAK_STEPS[1]} km/h`, url: svgUrl(streak(8.5) + streak(15.5)) },
	{
		name: "wind-3",
		label: `${STREAK_STEPS[1]} km/h or more`,
		url: svgUrl(streak(6.5, 8) + streak(12) + streak(17.5, 8)),
	},
] as const;

/** Adds the wind images to the map's style; the wind layer draws nothing until they're added. */
export async function addWindIcons(map: MapLibreMap) {
	await Promise.all(
		WIND_ICONS.map(async ({ name, url }) => {
			const image = new Image(48, 48);
			image.src = url;
			await image.decode();
			if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
		}),
	);
}

/** Points with a modeled wind speed, and a direction unless calm: no value draws no arrow, never calm. */
export const WIND_FILTER: FilterSpecification = [
	"all",
	["!=", ["get", "windKmh"], null],
	["any", ["<", ["get", "windKmh"], CALM_KMH], ["!=", ["get", "windDirectionDeg"], null]],
];

export const WIND_LAYOUT: SymbolLayerSpecification["layout"] = {
	"icon-image": [
		"case",
		["<", ["get", "windKmh"], CALM_KMH],
		"wind-calm",
		["step", ["get", "windKmh"], "wind-1", STREAK_STEPS[0], "wind-2", STREAK_STEPS[1], "wind-3"],
	],
	"icon-size": ["interpolate", ["linear"], ["get", "windKmh"], 0, 0.75, 40, 1.3],
	// The direction is where the wind comes from; the icon points up, so it turns to where it blows.
	"icon-rotate": ["+", ["coalesce", ["get", "windDirectionDeg"], 0], 180],
	"icon-rotation-alignment": "map",
	"icon-allow-overlap": true,
	"icon-ignore-placement": true,
};
