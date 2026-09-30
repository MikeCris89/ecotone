"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Map, { Layer, Source, type StyleSpecification } from "react-map-gl/maplibre";
import { type LayerSummary, type LayerVisibility, MapPanel } from "@/components/map-panel";
import {
	DETECTION_COLOR,
	OBSERVATION_COLOR,
	OBSERVATION_DENSE_COLOR,
	TEMPERATURE_COLOR,
} from "@/components/map-colors";
import { guardMissingNumbers } from "@/lib/basemap-style";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { InatMapRow } from "@/lib/inaturalist/map";
import {
	firmsGeoJson,
	inatGeoJson,
	inatInWindow,
	inatWindowFilter,
	instantInWindow,
	instantWindowFilter,
	type MapLayerResponse,
	type MapWindow,
	type PointCollection,
	type WeatherLayerResponse,
	weatherGeoJson,
	windowBounds,
} from "@/lib/map-layers";

const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron";

// The live-california dataset's bbox.
const CALIFORNIA: [[number, number], [number, number]] = [
	[-124.5, 32.5],
	[-114.1, 42],
];

// Sources stay mounted with no features until their data arrives, so the layers keep their
// stacking order whichever response lands first.
const EMPTY: PointCollection<never> = { type: "FeatureCollection", features: [] };

// MapLibre rejects `filter: undefined` when adding a layer and skips it, so a layer gets no filter
// prop until its data (and window) exists. Every layer is then added at style load, in the order
// written, and later filters go through setFilter on a layer that exists.
function windowFilter(filter: ReturnType<typeof instantWindowFilter> | undefined) {
	return filter ? { filter } : {};
}

// Fetched here rather than by MapLibre so its filters can be patched before the map sees them
// (react-map-gl doesn't pass MapLibre's transformStyle through). Assumes the style's sprite,
// glyph and tile URLs are absolute, as OpenFreeMap's are.
async function fetchBasemapStyle(): Promise<StyleSpecification> {
	const response = await fetch(MAP_STYLE_URL);
	if (!response.ok) throw new Error(`Basemap style: HTTP ${response.status}`);
	return guardMissingNumbers(await response.json());
}

async function fetchLayer<T>(source: string): Promise<T> {
	const response = await fetch(`/api/map/${source}`);
	if (!response.ok) throw new Error(`${source} map layer: HTTP ${response.status}`);
	return response.json();
}

// Each layer refreshes on its source's poll cadence. The query key never changes (the window is
// applied on the client), so a refetch, or a failed one, keeps showing the previous data without
// needing placeholderData.
function useMapLayer<T>(source: string, minutes: number) {
	return useQuery({
		queryKey: ["map-layer", source],
		queryFn: () => fetchLayer<T>(source),
		refetchInterval: minutes * 60_000,
		staleTime: minutes * 60_000,
	});
}

// `time` reads a row's time (the start of its span, for iNaturalist). The routes return rows newest
// first and a capped layer drops the oldest, so the last row marks where the loaded data stops.
function summarize<Row>(
	query: UseQueryResult<MapLayerResponse<Row>>,
	inWindow: number,
	time: (row: Row) => number,
): LayerSummary {
	const { data } = query;
	const lastRow = data?.truncated ? data.rows.at(-1) : undefined;
	return {
		loading: query.isPending,
		failed: query.isError,
		dataAsOf: data ? Date.parse(data.end) : null,
		inWindow,
		omitted: data ? data.total - data.rows.length : 0,
		oldestLoaded: lastRow ? time(lastRow) : null,
		attribution: data?.attribution ?? null,
	};
}

export function LiveMap() {
	const [mapWindow, setMapWindow] = useState<MapWindow>("7d");
	const [visible, setVisible] = useState<LayerVisibility>({ inaturalist: true, firms: true, weather: false });

	const inaturalist = useMapLayer<MapLayerResponse<InatMapRow>>("inaturalist", 5);
	const firms = useMapLayer<MapLayerResponse<FirmsMapRow>>("firms", 15);
	const weather = useMapLayer<WeatherLayerResponse>("weather", 60);
	const basemap = useQuery({
		queryKey: ["basemap-style", MAP_STYLE_URL],
		queryFn: fetchBasemapStyle,
		staleTime: Infinity,
		retry: false,
	});
	// If fetching the style fails, MapLibre loads the URL itself, unpatched.
	const mapStyle = basemap.data ?? (basemap.isError ? MAP_STYLE_URL : undefined);

	// Built once per response; a new object here is what makes MapLibre re-read the data.
	const inatData = useMemo(() => (inaturalist.data ? inatGeoJson(inaturalist.data.rows) : EMPTY), [inaturalist.data]);
	const firmsData = useMemo(() => (firms.data ? firmsGeoJson(firms.data.rows) : EMPTY), [firms.data]);
	const weatherData = useMemo(
		() => (weather.data ? weatherGeoJson(weather.data.points, weather.data.rows) : EMPTY),
		[weather.data],
	);

	// Changing the window only swaps these filters and recounts; the data stays as loaded.
	const inatWindow = inaturalist.data && windowBounds(inaturalist.data.end, mapWindow);
	const firmsWindow = firms.data && windowBounds(firms.data.end, mapWindow);
	const weatherWindow = weather.data && windowBounds(weather.data.end, mapWindow);
	const inatFilter = inatWindow && inatWindowFilter(inatWindow);
	const firmsFilter = firmsWindow && instantWindowFilter(firmsWindow);
	const weatherFilter = weatherWindow && instantWindowFilter(weatherWindow);

	// Counted with the same rules as the filters (a few ms at most for a full layer).
	const inatShown = inatWindow
		? inatData.features.filter(({ properties }) => inatInWindow(properties.from, properties.to, inatWindow))
		: [];
	const firmsShown = firmsWindow
		? firmsData.features.filter(({ properties }) => instantInWindow(properties.time, firmsWindow))
		: [];
	const weatherShown = weatherWindow
		? weatherData.features.filter(({ properties }) => instantInWindow(properties.time, weatherWindow))
		: [];
	const latestHour = weatherShown.length ? Math.max(...weatherShown.map(({ properties }) => properties.time)) : null;

	const visibility = (layer: keyof LayerVisibility) => (visible[layer] ? "visible" : "none");

	return (
		<div className="relative h-dvh w-full">
			{mapStyle && (
				<Map
					initialViewState={{ bounds: CALIFORNIA, fitBoundsOptions: { padding: 40 } }}
					mapStyle={mapStyle}
					style={{ width: "100%", height: "100%" }}
				>
					<Source id="weather" type="geojson" data={weatherData}>
						<Layer
							id="weather-points"
							type="circle"
							{...windowFilter(weatherFilter)}
							layout={{ visibility: visibility("weather") }}
							paint={{
								"circle-radius": 6,
								"circle-color": TEMPERATURE_COLOR,
								"circle-stroke-color": "#ffffff",
								"circle-stroke-width": 1,
							}}
						/>
					</Source>
					<Source id="inaturalist" type="geojson" data={inatData}>
						{/* Density at statewide zooms, fading out as individual records take over. */}
						<Layer
							id="inaturalist-heat"
							type="heatmap"
							maxzoom={9}
							{...windowFilter(inatFilter)}
							layout={{ visibility: visibility("inaturalist") }}
							paint={{
								"heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 6, 9, 18],
								"heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 9, 1.5],
								"heatmap-color": [
									"interpolate",
									["linear"],
									["heatmap-density"],
									0,
									"rgba(27, 175, 122, 0)",
									0.2,
									"rgba(27, 175, 122, 0.35)",
									0.6,
									"rgba(27, 175, 122, 0.7)",
									1,
									OBSERVATION_DENSE_COLOR,
								],
								"heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 9, 0],
							}}
						/>
						{/*
						 * Precise records are filled; unknown accuracy is a hollow ring; imprecise or obscured
						 * records are larger and faint, since their true location may be kilometres away.
						 */}
						<Layer
							id="inaturalist-points"
							type="circle"
							minzoom={7}
							{...windowFilter(inatFilter)}
							layout={{ visibility: visibility("inaturalist") }}
							paint={{
								"circle-radius": ["match", ["get", "precision"], "imprecise", 8, 4],
								"circle-color": OBSERVATION_COLOR,
								"circle-opacity": [
									"interpolate",
									["linear"],
									["zoom"],
									7,
									0,
									8,
									["match", ["get", "precision"], "precise", 0.9, "imprecise", 0.2, 0],
								],
								"circle-stroke-color": [
									"match",
									["get", "precision"],
									"unknown-accuracy",
									OBSERVATION_COLOR,
									"#ffffff",
								],
								"circle-stroke-width": ["match", ["get", "precision"], "unknown-accuracy", 1.5, "precise", 1, 0],
								"circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 8, 1],
							}}
						/>
					</Source>
					<Source id="firms" type="geojson" data={firmsData}>
						<Layer
							id="firms-points"
							type="circle"
							{...windowFilter(firmsFilter)}
							layout={{ visibility: visibility("firms") }}
							paint={{
								"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6],
								"circle-color": DETECTION_COLOR,
								"circle-stroke-color": "#ffffff",
								"circle-stroke-width": 1,
							}}
						/>
					</Source>
				</Map>
			)}
			<MapPanel
				mapWindow={mapWindow}
				onWindowChange={setMapWindow}
				visible={visible}
				onVisibleChange={setVisible}
				inaturalist={summarize(inaturalist, inatShown.length, (row) => row[3])}
				firms={summarize(firms, firmsShown.length, (row) => row[3])}
				weather={{ ...summarize(weather, weatherShown.length, (row) => row[1]), latestHour }}
			/>
		</div>
	);
}
