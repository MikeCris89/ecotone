"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { GeoJSONSource, Popup as MapLibrePopup } from "maplibre-gl";
import { useCallback, useMemo, useRef, useState } from "react";
import Map, {
	AttributionControl,
	Layer,
	type MapLayerMouseEvent,
	type MapRef,
	Popup,
	Source,
} from "react-map-gl/maplibre";
import { ChatPanel } from "@/components/chat-panel";
import { type LayerSummary, type LayerVisibility, MapPanel } from "@/components/map-panel";
import { MapPopupContent, type MapSelection, type WeatherPopupData } from "@/components/map-popup";
import { Timeline } from "@/components/timeline";
import {
	DETECTION_COLOR,
	OBSERVATION_COLOR,
	OBSERVATION_DENSE_COLOR,
	TEMPERATURE_COLOR,
} from "@/components/map-colors";
import type { ChatContext } from "@/lib/chat/context";
import { suggestedQuestions } from "@/lib/chat/ui";
import { layerCoverage } from "@/lib/coverage";
import type { FirmsMapRow } from "@/lib/firms/map";
import type { Freshness } from "@/lib/freshness";
import type { InatMapRow } from "@/lib/inaturalist/map";
import {
	FIRMS_CLUSTER,
	FIRMS_CLUSTER_RADIUS,
	firmsGeoJson,
	inatGeoJson,
	inatInWindow,
	inatWindowFilter,
	instantInWindow,
	LAYER_REFRESH_MINUTES,
	latestWeatherRows,
	type MapLayerName,
	type MapLayerResponse,
	type MapWindow,
	type PointCollection,
	type PointFeature,
	type TimeWindow,
	type WeatherLayerResponse,
	weatherGeoJson,
	windowBounds,
} from "@/lib/map-layers";
import {
	clampHour,
	countByHour,
	countDateOnlyByDay,
	firmsTimes,
	lastHour,
	recencyFade,
	spanToHour,
	stepWindow,
	TRAILING_HOURS,
	timedInatTimes,
	weatherLookback,
	weatherStaleOpacity,
} from "@/lib/timeline";

const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron";

// The live-california dataset's bbox.
const CALIFORNIA: [[number, number], [number, number]] = [
	[-124.5, 32.5],
	[-114.1, 42],
];

// Sources stay mounted with no features until their data arrives, so the layers keep their
// stacking order whichever response lands first.
const EMPTY: PointCollection<never> = { type: "FeatureCollection", features: [] };

// Clickable layers. Their source IDs match MapSelection's sources, except FIRMS clusters, which
// aren't records: clicking one zooms in until it splits.
const INTERACTIVE_LAYERS = ["firms-clusters", "firms-points", "inaturalist-points", "weather-points"];

// Zooms over which iNaturalist circles fade in. The heatmap fades out more slowly, until zoom 9.
const INAT_POINTS_FADE = { from: 7, to: 8 };

/**
 * The records under the pointer, topmost first (MapLibre returns them in drawing order).
 * MapLibre returns iNaturalist circles even while they're transparent, so they only count from
 * halfway through their fade-in. A point touching several tiles can be returned once per tile.
 */
function recordsAt(event: MapLayerMouseEvent): MapSelection[] {
	const zoom = event.target.getZoom();
	const seen = new Set<string>();
	const records: MapSelection[] = [];
	for (const { source, properties } of event.features ?? []) {
		const { id } = properties;
		let record: MapSelection | undefined;
		if (source === "firms" && typeof id === "string") record = { source, id, more: 0 };
		if (source === "weather" && typeof id === "number") record = { source, id, more: 0 };
		if (source === "inaturalist" && typeof id === "number") {
			if (zoom < (INAT_POINTS_FADE.from + INAT_POINTS_FADE.to) / 2) continue;
			record = { source, id, more: 0 };
		}
		const key = `${source}:${id}`;
		if (!record || seen.has(key)) continue;
		seen.add(key);
		records.push(record);
	}
	return records;
}

function isCluster(feature: NonNullable<MapLayerMouseEvent["features"]>[number]) {
	return feature.layer.id === "firms-clusters";
}

async function zoomIntoCluster(event: MapLayerMouseEvent) {
	const cluster = event.features?.[0];
	if (!cluster || cluster.geometry.type !== "Point") return;
	const source = event.target.getSource<GeoJSONSource>("firms");
	const zoom = await source?.getClusterExpansionZoom(cluster.properties.cluster_id);
	event.target.easeTo({ center: cluster.geometry.coordinates as [number, number], zoom });
}

function findFeature(features: PointFeature<{ id: number | string }>[], id: number | string) {
	return features.find(({ properties }) => properties.id === id);
}

// MapLibre rejects `filter: undefined` when adding a layer and skips it, so a layer gets no filter
// prop until its data (and window) exists. Every layer is then added at style load, in the order
// written, and later filters go through setFilter on a layer that exists.
function windowFilter(filter: ReturnType<typeof inatWindowFilter> | undefined) {
	return filter ? { filter } : {};
}

async function fetchLayer<T>(source: MapLayerName): Promise<T> {
	const response = await fetch(`/api/map/${source}`);
	if (!response.ok) throw new Error(`${source} map layer: HTTP ${response.status}`);
	return response.json();
}

// Feed health and coverage change as polls land, every few minutes; the route is cached for one.
function useFreshness() {
	return useQuery({
		queryKey: ["freshness"],
		queryFn: async (): Promise<Freshness> => {
			const response = await fetch("/api/freshness");
			if (!response.ok) throw new Error(`Freshness: HTTP ${response.status}`);
			return response.json();
		},
		refetchInterval: 60_000,
		staleTime: 60_000,
	});
}

// Each layer refreshes on its source's poll cadence. The query key never changes (the window is
// applied on the client), so a refetch, or a failed one, keeps showing the previous data without
// needing placeholderData.
function useMapLayer<T>(source: MapLayerName) {
	const minutes = LAYER_REFRESH_MINUTES[source].poll;
	return useQuery({
		queryKey: ["map-layer", source],
		queryFn: () => fetchLayer<T>(source),
		refetchInterval: minutes * 60_000,
		staleTime: minutes * 60_000,
	});
}

/**
 * The span a layer shows: while the whole window is shown, its own window, ending at its own
 * response's `end`; while scrubbing, the handle's span on the shared timeline. Stable between
 * renders, so counts and filters only recompute when it changes.
 */
function useShownSpan(responseEnd: string | undefined, mapWindow: MapWindow, scrubbed: TimeWindow | null) {
	return useMemo(
		() => (responseEnd ? (scrubbed ?? windowBounds(responseEnd, mapWindow)) : undefined),
		[responseEnd, mapWindow, scrubbed],
	);
}

/**
 * The time range a layer's rows cover, for shading the rest of its timeline row: its window, or
 * from its oldest row when capped (as in summarize), to its end.
 */
function loadedSpan<Row>(data: MapLayerResponse<Row> | undefined, time: (row: Row) => number): TimeWindow | null {
	if (!data) return null;
	const lastRow = data.truncated ? data.rows.at(-1) : undefined;
	return { start: lastRow ? time(lastRow) : Date.parse(data.start) / 1000, end: Date.parse(data.end) / 1000 };
}

// `time` reads a row's time (the start of its span, for iNaturalist). The routes return rows newest
// first and a capped layer drops the oldest, so the last row marks where the loaded data stops.
function summarize<Row>(
	query: UseQueryResult<MapLayerResponse<Row>>,
	inWindow: number,
	time: (row: Row) => number,
): Omit<LayerSummary, "coverage"> {
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
	const [selection, setSelection] = useState<MapSelection | null>(null);
	// The start of the timeline handle's hour (epoch seconds), or null for the whole window.
	const [hour, setHour] = useState<number | null>(null);
	const [cursor, setCursor] = useState<string>();
	const mapRef = useRef<MapRef>(null);
	const popupRef = useRef<MapLibrePopup>(null);
	// MapLibre picks the popup's side (above, below, ...) from its size only when placed or when the
	// map moves, so content growing from "Loading…" into details could run off the map's edge.
	// Setting the same position again makes it measure and choose again.
	const reanchorPopup = useCallback(() => {
		const popup = popupRef.current;
		if (popup?.isOpen()) popup.setLngLat(popup.getLngLat());
	}, []);

	const inaturalist = useMapLayer<MapLayerResponse<InatMapRow>>("inaturalist");
	const firms = useMapLayer<MapLayerResponse<FirmsMapRow>>("firms");
	const weather = useMapLayer<WeatherLayerResponse>("weather");
	const freshness = useFreshness().data;

	// The timeline ends at the newest response's end, since the layers refresh on different cadences.
	// A layer whose data ends earlier has its last hours shaded as not loaded on the timeline.
	const ends = [inaturalist.data, firms.data, weather.data].flatMap((data) => (data ? [Date.parse(data.end)] : []));
	const latestEnd = ends.length ? Math.max(...ends) : null;
	// Every layer loads the 7-day window (the routes' default) whatever window is selected.
	const loaded = useMemo(
		() => (latestEnd === null ? null : windowBounds(new Date(latestEnd).toISOString(), "7d")),
		[latestEnd],
	);
	const timeline = useMemo(
		() => loaded && stepWindow(windowBounds(new Date(loaded.end * 1000).toISOString(), mapWindow), loaded),
		[loaded, mapWindow],
	);
	// A refresh slides the window forward and a narrower window drops its oldest hours: keep the
	// handle on the timeline, at its nearest end, rather than jumping back to the whole window.
	if (hour !== null && timeline && clampHour(hour, timeline) !== hour) setHour(clampHour(hour, timeline));

	// Records show for the trailing day to the handle, which can reach back before the selected
	// window into the loaded data.
	const trailing = useMemo(
		() => (hour !== null && loaded ? spanToHour(hour, TRAILING_HOURS, loaded) : null),
		[hour, loaded],
	);
	const inatSpan = useShownSpan(inaturalist.data?.end, mapWindow, trailing);
	const firmsSpan = useShownSpan(firms.data?.end, mapWindow, trailing);
	const fadeEnd = trailing?.end ?? null;
	// Weather shows one hour: the handle's, or the timeline's newest when the whole window is shown.
	const weatherHour = timeline ? (hour ?? lastHour(timeline)) : null;
	const weatherSpan = useMemo(() => (weatherHour === null ? null : weatherLookback(weatherHour)), [weatherHour]);

	// Built once per response; a new object here is what makes MapLibre re-read the data.
	const inatData = useMemo(() => (inaturalist.data ? inatGeoJson(inaturalist.data.rows) : EMPTY), [inaturalist.data]);
	const firmsData = useMemo(() => (firms.data ? firmsGeoJson(firms.data.rows) : EMPTY), [firms.data]);
	// Weather is rebuilt per hour shown instead (169 points): each point at its reading for that hour,
	// or its latest one within the lookback, drawn as stale.
	const weatherRows = useMemo(
		() => (weather.data && weatherSpan ? weather.data.rows.filter(([, time]) => instantInWindow(time, weatherSpan)) : []),
		[weather.data, weatherSpan],
	);
	const weatherData = useMemo(
		() => (weather.data ? weatherGeoJson(weather.data.points, weatherRows) : EMPTY),
		[weather.data, weatherRows],
	);
	const latestWeather = useMemo(() => latestWeatherRows(weatherRows), [weatherRows]);
	// Each point's newest loaded reading: the one its retrieval time (WeatherMapPoint) belongs to.
	const newestWeather = useMemo(() => weather.data && latestWeatherRows(weather.data.rows), [weather.data]);

	// Changing the span only swaps these filters and recounts; the data stays as loaded.
	const inatFilter = inatSpan && inatWindowFilter(inatSpan);

	// Counted with the same rules as the filters (a few ms at most for a full layer), once per span:
	// hovering re-renders on every mouse move.
	const inatShown = useMemo(
		() =>
			inatSpan
				? inatData.features.filter(({ properties }) => inatInWindow(properties.from, properties.to, inatSpan))
				: [],
		[inatData, inatSpan],
	);
	const firmsShown = useMemo(
		() => (firmsSpan ? firmsData.features.filter(({ properties }) => instantInWindow(properties.time, firmsSpan)) : []),
		[firmsData, firmsSpan],
	);
	// FIRMS is clustered, which happens in the source before any layer filter, so its source holds
	// only the shown detections instead of filtering them.
	const firmsShownData = useMemo(() => ({ ...firmsData, features: firmsShown }), [firmsData, firmsShown]);
	const weatherShown = weatherData.features;
	const staleWeather =
		weatherHour === null ? 0 : weatherShown.filter(({ properties }) => properties.time < weatherHour).length;

	// The timeline's bars, per hour of its axis; date-only records per date, never spread over hours.
	const observationsPerHour = useMemo(
		() => timeline && countByHour(inaturalist.data ? timedInatTimes(inaturalist.data.rows) : [], timeline),
		[inaturalist.data, timeline],
	);
	const dateOnlyPerDay = useMemo(
		() => (timeline && inaturalist.data ? countDateOnlyByDay(inaturalist.data.rows, timeline) : []),
		[inaturalist.data, timeline],
	);
	const detectionsPerHour = useMemo(
		() => timeline && countByHour(firms.data ? firmsTimes(firms.data.rows) : [], timeline),
		[firms.data, timeline],
	);

	// The popup stays open while its record is on the map. A hidden layer, a window or timeline span
	// that filters the record out, or a refresh that drops it closes the popup rather than leaving a
	// stale one. Cleared during render, React's pattern for state derived from other state: it
	// re-renders before painting, so the popup never flashes.
	const selectedFeature = useMemo(() => {
		if (!selection || !visible[selection.source]) return undefined;
		const shown = { inaturalist: inatShown, firms: firmsShown, weather: weatherShown };
		return findFeature(shown[selection.source], selection.id);
	}, [selection, visible, inatShown, firmsShown, weatherShown]);
	if (selection && !selectedFeature) setSelection(null);

	// Weather popups read the loaded layer: the point's reading as the map draws it. The point's
	// retrieval time is its newest reading's, so an earlier reading's isn't known here.
	let weatherPopup: WeatherPopupData | undefined;
	if (selection?.source === "weather" && weather.data && weatherHour !== null) {
		const point = weather.data.points.find(([id]) => id === selection.id);
		const row = latestWeather.get(selection.id);
		const model = weather.data.filters.model[0];
		if (point && row) {
			const retrievedAt = newestWeather?.get(selection.id)?.[1] === row[1] ? point[7] : null;
			weatherPopup = { point, row, model, attribution: weather.data.attribution, hourShown: weatherHour, retrievedAt };
		}
	}

	const observationsLoaded = useMemo(() => loadedSpan(inaturalist.data, (row) => row[3]), [inaturalist.data]);
	const detectionsLoaded = useMemo(() => loadedSpan(firms.data, (row) => row[3]), [firms.data]);

	// Read when a question is sent, so panning doesn't re-render the chat.
	const chatContext = useCallback((): ChatContext => {
		const bounds = mapRef.current?.getBounds();
		const [[west, south], [east, north]] = CALIFORNIA;
		return {
			view: bounds
				? { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() }
				: { west, south, east, north },
			window: mapWindow,
			hour,
			end: latestEnd === null ? null : new Date(latestEnd).toISOString(),
		};
	}, [mapWindow, hour, latestEnd]);
	// From the counts the legend shows.
	const suggestions = useMemo(
		() =>
			suggestedQuestions({
				window: mapWindow,
				observations: inatShown.length,
				detections: firmsShown.length,
				weatherReadings: weatherShown.length,
			}),
		[mapWindow, inatShown.length, firmsShown.length, weatherShown.length],
	);

	const visibility = (layer: keyof LayerVisibility) => (visible[layer] ? "visible" : "none");

	return (
		<div className="relative h-dvh w-full">
			<Map
				ref={mapRef}
				initialViewState={{ bounds: CALIFORNIA, fitBoundsOptions: { padding: 40 } }}
				mapStyle={MAP_STYLE_URL}
				style={{ width: "100%", height: "100%" }}
				attributionControl={false}
				interactiveLayerIds={INTERACTIVE_LAYERS}
				cursor={cursor}
				onMouseMove={(event) =>
					setCursor(recordsAt(event).length || event.features?.some(isCluster) ? "pointer" : undefined)
				}
				onClick={(event) => {
					if (event.features?.[0] && isCluster(event.features[0])) return void zoomIntoCluster(event);
					const [top, ...rest] = recordsAt(event);
					setSelection(top ? { ...top, more: rest.length } : null);
				}}
			>
				<Source id="weather" type="geojson" data={weatherData}>
					<Layer
						id="weather-points"
						type="circle"
						layout={{ visibility: visibility("weather") }}
						paint={{
							"circle-radius": 6,
							"circle-color": TEMPERATURE_COLOR,
							...(weatherHour !== null && { "circle-opacity": weatherStaleOpacity(weatherHour) }),
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
							"heatmap-weight": recencyFade(fadeEnd, "to"),
						}}
					/>
					{/*
					 * Precise records are filled; unknown accuracy is a hollow ring; imprecise or obscured
					 * records are larger and faint, since their true location may be kilometres away.
					 */}
					<Layer
						id="inaturalist-points"
						type="circle"
						minzoom={INAT_POINTS_FADE.from}
						{...windowFilter(inatFilter)}
						layout={{ visibility: visibility("inaturalist") }}
						paint={{
							"circle-radius": ["match", ["get", "precision"], "imprecise", 8, 4],
							"circle-color": OBSERVATION_COLOR,
							"circle-opacity": [
								"interpolate",
								["linear"],
								["zoom"],
								INAT_POINTS_FADE.from,
								0,
								INAT_POINTS_FADE.to,
								["*", ["match", ["get", "precision"], "precise", 0.9, "imprecise", 0.2, 0], recencyFade(fadeEnd, "to")],
							],
							"circle-stroke-color": [
								"match",
								["get", "precision"],
								"unknown-accuracy",
								OBSERVATION_COLOR,
								"#ffffff",
							],
							"circle-stroke-width": ["match", ["get", "precision"], "unknown-accuracy", 1.5, "precise", 1, 0],
							"circle-stroke-opacity": [
								"interpolate",
								["linear"],
								["zoom"],
								INAT_POINTS_FADE.from,
								0,
								INAT_POINTS_FADE.to,
								recencyFade(fadeEnd, "to"),
							],
						}}
					/>
				</Source>
				<Source id="firms" type="geojson" data={firmsShownData} {...FIRMS_CLUSTER}>
					<Layer
						id="firms-clusters"
						type="circle"
						filter={["has", "point_count"]}
						layout={{ visibility: visibility("firms") }}
						// A ring with a faint fill: the recorded observations under a group stay visible.
						paint={{
							"circle-radius": FIRMS_CLUSTER_RADIUS,
							"circle-color": DETECTION_COLOR,
							"circle-opacity": ["*", 0.15, recencyFade(fadeEnd, "time")],
							"circle-stroke-color": DETECTION_COLOR,
							"circle-stroke-width": 2,
							"circle-stroke-opacity": recencyFade(fadeEnd, "time"),
						}}
					/>
					<Layer
						id="firms-points"
						type="circle"
						filter={["!", ["has", "point_count"]]}
						layout={{ visibility: visibility("firms") }}
						paint={{
							"circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6],
							"circle-color": DETECTION_COLOR,
							"circle-opacity": recencyFade(fadeEnd, "time"),
							"circle-stroke-color": "#ffffff",
							"circle-stroke-width": 1,
							"circle-stroke-opacity": recencyFade(fadeEnd, "time"),
						}}
					/>
				</Source>
				{selection && selectedFeature && (
					// The map's click handler opens and closes popups, so MapLibre's own close-on-click stays off.
					<Popup
						ref={popupRef}
						longitude={selectedFeature.geometry.coordinates[0]}
						latitude={selectedFeature.geometry.coordinates[1]}
						closeOnClick={false}
						maxWidth="none"
						onClose={() => setSelection(null)}
					>
						<MapPopupContent selection={selection} weather={weatherPopup} onResize={reanchorPopup} />
					</Popup>
				)}
				{/* Top-right: the timeline covers the bottom edge. */}
				<AttributionControl position="top-right" />
			</Map>
			{/*
			 * The legend on the left and the chat on the right (below the attribution), above the timeline.
			 * Each scrolls when it would reach the timeline, whatever the timeline's height.
			 */}
			<div className="pointer-events-none absolute inset-3 flex flex-col gap-3">
				<div className="flex min-h-0 flex-1 items-start justify-between gap-3">
					<div className="flex max-h-full min-h-0 flex-col">
						<MapPanel
							mapWindow={mapWindow}
							onWindowChange={setMapWindow}
							visible={visible}
							onVisibleChange={setVisible}
							inaturalist={{
								...summarize(inaturalist, inatShown.length, (row) => row[3]),
								coverage: freshness ? layerCoverage(freshness, "inaturalist", inatSpan) : null,
							}}
							firms={{
								...summarize(firms, firmsShown.length, (row) => row[3]),
								coverage: freshness ? layerCoverage(freshness, "firms", firmsSpan) : null,
							}}
							weather={{
								...summarize(weather, weatherShown.length, (row) => row[1]),
								// The weather layer falls back to earlier readings itself, so it gets no unread note.
								coverage: freshness ? layerCoverage(freshness, "open-meteo", undefined) : null,
								hourShown: weatherShown.length ? weatherHour : null,
								stale: staleWeather,
							}}
						/>
					</div>
					<div className="flex max-h-full min-h-0 flex-col pt-8">
						<ChatPanel context={chatContext} suggestions={suggestions} />
					</div>
				</div>
				{timeline && observationsPerHour && detectionsPerHour && (
					<Timeline
						window={timeline}
						hour={hour}
						span={trailing}
						onHourChange={setHour}
						observations={observationsPerHour}
						detections={detectionsPerHour}
						dateOnly={dateOnlyPerDay}
						observationsLoaded={observationsLoaded}
						detectionsLoaded={detectionsLoaded}
						observationsCoverage={freshness?.sources.inaturalist ?? null}
						detectionsCoverage={freshness?.sources.firms ?? null}
					/>
				)}
			</div>
		</div>
	);
}
