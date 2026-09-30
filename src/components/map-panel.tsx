"use client";

import type { ReactNode } from "react";
import {
	DETECTION_COLOR,
	NO_VALUE_COLOR,
	OBSERVATION_COLOR,
	TEMPERATURE_STOPS,
} from "@/components/map-colors";
import type { SourceAttribution } from "@/lib/data-sources";
import { PRECISE_ACCURACY_M } from "@/lib/default-filters";
import { FIRMS_CLUSTER, type MapWindow, WINDOW_HOURS } from "@/lib/map-layers";
import { formatTime, WEATHER_MAX_AGE_HOURS } from "@/lib/timeline";

export type LayerVisibility = { inaturalist: boolean; firms: boolean; weather: boolean };

/** What the legend says about one layer in the selected window. */
export type LayerSummary = {
	loading: boolean;
	// The latest fetch failed; earlier data, if any, is still on the map.
	failed: boolean;
	// When the server read the data on the map (the response's `end`), epoch ms: a CDN-cached
	// response can be minutes older than the browser's fetch. Null until a fetch succeeds.
	dataAsOf: number | null;
	inWindow: number;
	// Older records past the layer's cap, which the route left out, all from `oldestLoaded` (epoch
	// seconds) or earlier. Null when nothing was left out.
	omitted: number;
	oldestLoaded: number | null;
	attribution: SourceAttribution | null;
};

const WINDOW_LABELS: Record<MapWindow, string> = { "24h": "24h", "3d": "3 days", "7d": "7 days" };

type MapPanelProps = {
	mapWindow: MapWindow;
	onWindowChange: (window: MapWindow) => void;
	visible: LayerVisibility;
	onVisibleChange: (visible: LayerVisibility) => void;
	inaturalist: LayerSummary;
	firms: LayerSummary;
	// The hour the weather layer shows (null when no point has a reading for it), and how many
	// points fall back to an earlier reading.
	weather: LayerSummary & { hourShown: number | null; stale: number };
};

// Top-left, above the timeline (the parent stacks them), leaving the right side for the chat panel.
export function MapPanel(props: MapPanelProps) {
	const { mapWindow, onWindowChange, visible, onVisibleChange, inaturalist, firms, weather } = props;
	const toggle = (layer: keyof LayerVisibility) => (checked: boolean) =>
		onVisibleChange({ ...visible, [layer]: checked });

	return (
		<div className="pointer-events-auto min-h-0 w-80 space-y-3 overflow-y-auto rounded-lg bg-white/95 p-3 text-sm text-zinc-900 shadow-md">
			<h1 className="font-semibold">Live California</h1>

			<div className="flex rounded-md border border-zinc-200 p-0.5" role="group" aria-label="Time window">
				{(Object.keys(WINDOW_HOURS) as MapWindow[]).map((window) => (
					<button
						key={window}
						type="button"
						aria-pressed={window === mapWindow}
						onClick={() => onWindowChange(window)}
						className={`flex-1 rounded px-2 py-1 ${
							window === mapWindow ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
						}`}
					>
						{WINDOW_LABELS[window]}
					</button>
				))}
			</div>

			<LayerEntry
				label="Recorded observations"
				swatch={OBSERVATION_COLOR}
				checked={visible.inaturalist}
				onChange={toggle("inaturalist")}
				summary={inaturalist}
				count={inaturalist.inWindow.toLocaleString()}
				emptyText="No recorded observations in this window."
			>
				<p>Shown as recorded observation density when zoomed out.</p>
				<ul className="flex flex-wrap gap-x-3 gap-y-1">
					<li className="flex items-center gap-1">
						<span className="size-2.5 rounded-full" style={{ backgroundColor: OBSERVATION_COLOR }} />
						Precise (≤{PRECISE_ACCURACY_M / 1000} km)
					</li>
					<li className="flex items-center gap-1">
						<span className="size-3.5 rounded-full opacity-30" style={{ backgroundColor: OBSERVATION_COLOR }} />
						Imprecise or obscured
					</li>
					<li className="flex items-center gap-1">
						<span className="size-2.5 rounded-full border-[1.5px]" style={{ borderColor: OBSERVATION_COLOR }} />
						Accuracy unknown
					</li>
				</ul>
			</LayerEntry>

			<LayerEntry
				label="Satellite thermal detections"
				swatch={DETECTION_COLOR}
				checked={visible.firms}
				onChange={toggle("firms")}
				summary={firms}
				count={firms.inWindow.toLocaleString()}
				emptyText="No qualifying satellite thermal detections in this window."
			>
				<p className="flex items-center gap-1">
					<span
						className="size-4 shrink-0 rounded-full border-2"
						style={{ borderColor: DETECTION_COLOR, backgroundColor: `${DETECTION_COLOR}26` }}
					/>
					Zoomed out, {FIRMS_CLUSTER.clusterMinPoints} or more detections close together draw as one ring, bigger
					for more; click it to zoom in.
				</p>
			</LayerEntry>

			<LayerEntry
				label="Modeled conditions"
				swatch={TEMPERATURE_STOPS[2][1]}
				checked={visible.weather}
				onChange={toggle("weather")}
				summary={weather}
				count={`${weather.inWindow.toLocaleString()} points`}
				emptyText={`No modeled conditions within ${WEATHER_MAX_AGE_HOURS} h of the hour shown.`}
			>
				{weather.hourShown !== null && <p>Hour shown: {formatTime(weather.hourShown * 1000)}</p>}
				{weather.stale > 0 && (
					<p className="text-amber-800">
						{weather.stale.toLocaleString()} {weather.stale === 1 ? "point shows" : "points show"} an earlier
						reading, up to {WEATHER_MAX_AGE_HOURS} h old, drawn faded.
					</p>
				)}
				<TemperatureScale />
			</LayerEntry>
		</div>
	);
}

type LayerEntryProps = {
	label: string;
	swatch: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	summary: LayerSummary;
	count: string;
	emptyText: string;
	children?: ReactNode;
};

function LayerEntry({ label, swatch, checked, onChange, summary, count, emptyText, children }: LayerEntryProps) {
	const loaded = summary.dataAsOf !== null;
	const { attribution } = summary;

	return (
		<section className="space-y-1 border-t border-zinc-200 pt-2">
			<label className="flex items-center gap-2">
				<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
				<span className="size-3 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
				<span className="flex-1 font-medium">{label}</span>
				{loaded && <span className="text-zinc-600 tabular-nums">{count}</span>}
			</label>

			<div className="space-y-1 pl-5 text-xs text-zinc-600">
				{summary.loading && <p>Loading…</p>}
				{summary.failed && !loaded && <p className="text-red-700">Couldn&apos;t load this layer.</p>}
				{summary.failed && loaded && (
					<p className="text-amber-800">
						Couldn&apos;t refresh; showing data as of {formatTime(summary.dataAsOf!)}.
					</p>
				)}
				{loaded && summary.inWindow === 0 && <p>{emptyText}</p>}
				{summary.oldestLoaded !== null && (
					<p>
						The oldest {summary.omitted.toLocaleString()} records, from {formatTime(summary.oldestLoaded * 1000)}{" "}
						and earlier, are past this layer&apos;s cap and aren&apos;t loaded.
					</p>
				)}
				{children}
				{attribution && (
					<p className="text-[11px] text-zinc-500">
						<Linkified text={attribution.attributionText} />{" "}
						{attribution.licenseUrl && (
							<a className="underline" href={attribution.licenseUrl} target="_blank" rel="noreferrer">
								{attribution.license}
							</a>
						)}
					</p>
				)}
			</div>
		</section>
	);
}

// The stored attribution texts name their URLs inline, e.g. "Weather data by Open-Meteo.com
// (https://open-meteo.com/)"; CC BY asks for a working link.
function Linkified({ text }: { text: string }) {
	return text.split(/(https:\/\/[^\s)]+)/).map((part, index) =>
		part.startsWith("https://") ? (
			<a key={index} className="underline" href={part} target="_blank" rel="noreferrer">
				{part}
			</a>
		) : (
			part
		),
	);
}

// The stops are evenly spaced, so a CSS gradient through their colours matches the map's
// linear interpolation.
function TemperatureScale() {
	const last = TEMPERATURE_STOPS.length - 1;
	const gradient = `linear-gradient(to right, ${TEMPERATURE_STOPS.map(([, color]) => color).join(", ")})`;

	return (
		<div className="space-y-0.5">
			<p>Temperature (°C)</p>
			<div className="h-2 rounded-sm" style={{ background: gradient }} />
			<div className="flex justify-between tabular-nums">
				{TEMPERATURE_STOPS.map(([celsius], index) => (
					<span key={celsius}>
						{index === 0 ? "≤" : index === last ? "≥" : ""}
						{celsius}
					</span>
				))}
			</div>
			<p className="flex items-center gap-1">
				<span className="size-2.5 rounded-full" style={{ backgroundColor: NO_VALUE_COLOR }} />
				No model value
			</p>
		</div>
	);
}
