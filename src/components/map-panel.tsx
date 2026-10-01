"use client";

import type { ReactNode } from "react";
import { CollapseButton, type PanelOpen } from "@/components/collapse-button";
import {
	DETECTION_COLOR,
	NO_VALUE_COLOR,
	OBSERVATION_COLOR,
	WEATHER_COLORS,
	type WeatherColor,
} from "@/components/map-colors";
import { WIND_ICONS } from "@/components/wind-icons";
import type { LayerCoverage } from "@/lib/coverage";
import type { SourceAttribution } from "@/lib/data-sources";
import { PRECISE_ACCURACY_M } from "@/lib/default-filters";
import { FIRMS_CLUSTER, type MapWindow, WINDOW_HOURS } from "@/lib/map-layers";
import { formatTime, WEATHER_MAX_AGE_HOURS } from "@/lib/timeline";

export type LayerVisibility = { inaturalist: boolean; firms: boolean; weather: boolean };
/** What the weather layer draws: wind arrows, and points coloured by one variable or none. */
export type WeatherView = { wind: boolean; color: WeatherColor | null };

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
	// From /api/freshness; null until it loads.
	coverage: LayerCoverage | null;
};

const WINDOW_LABELS: Record<MapWindow, string> = { "24h": "24h", "3d": "3 days", "7d": "7 days" };

type MapPanelProps = {
	mapWindow: MapWindow;
	onWindowChange: (window: MapWindow) => void;
	visible: LayerVisibility;
	onVisibleChange: (visible: LayerVisibility) => void;
	weatherView: WeatherView;
	onWeatherViewChange: (view: WeatherView) => void;
	inaturalist: LayerSummary;
	firms: LayerSummary;
	// The hour the weather layer shows (null when no point has a reading for it), and how many
	// points fall back to an earlier reading.
	weather: LayerSummary & { hourShown: number | null; stale: number };
	// Collapsed on desktop, the panel keeps the window switch and one line per layer, so the map has
	// room but layers can still be toggled and a layer's warnings still show. On phones, only the
	// title and the window switch.
	open: PanelOpen;
	onOpenChange: (open: boolean) => void;
};

// Top-left, above the timeline (the parent stacks them), leaving the right side for the chat panel.
// Full width across the top on phones.
export function MapPanel(props: MapPanelProps) {
	const { mapWindow, onWindowChange, visible, onVisibleChange, weatherView, onWeatherViewChange } = props;
	const { inaturalist, firms, weather, open, onOpenChange } = props;
	const toggle = (layer: keyof LayerVisibility) => (checked: boolean) =>
		onVisibleChange({ ...visible, [layer]: checked });

	return (
		// The title and window switch stay put; only the layers below them scroll.
		<div className="pointer-events-auto flex min-h-0 w-full flex-col rounded-lg bg-white/95 text-sm text-zinc-900 shadow-md md:w-80">
			<div className="shrink-0 space-y-3 p-3">
				<div className="flex items-center justify-between">
					<h1 className="font-semibold">Live California</h1>
					<CollapseButton open={open} onChange={onOpenChange} label="map details" />
				</div>

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
			</div>

			<div className={`min-h-0 space-y-3 overflow-y-auto px-3 pb-3 ${open ? "" : "max-md:hidden"}`}>
				<LayerEntry
					open={open !== false}
					label="Recorded observations"
					swatch={OBSERVATION_COLOR}
					checked={visible.inaturalist}
					onChange={toggle("inaturalist")}
					summary={inaturalist}
					count={inaturalist.inWindow.toLocaleString()}
					emptyText="No recorded observations in this window."
					unreadText={(time) => `Recorded observations after ${time} haven't been read yet.`}
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
					open={open !== false}
					label="Satellite thermal detections"
					swatch={DETECTION_COLOR}
					checked={visible.firms}
					onChange={toggle("firms")}
					summary={firms}
					count={firms.inWindow.toLocaleString()}
					emptyText="No qualifying satellite thermal detections in this window."
					unreadText={(time) => `Satellite thermal detections after ${time} aren't published yet.`}
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
					open={open !== false}
					label="Modeled conditions"
					swatch={NO_VALUE_COLOR}
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
					<WeatherControls view={weatherView} onChange={onWeatherViewChange} />
				</LayerEntry>
			</div>
		</div>
	);
}

type LayerEntryProps = {
	// Collapsed: the toggle line alone, with a warning mark standing in for the details' warnings.
	open: boolean;
	label: string;
	swatch: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	summary: LayerSummary;
	count: string;
	emptyText: string;
	// For hours shown past what the source has read, given the time reading stopped. Used while
	// polling is on schedule; otherwise the note says polling is behind.
	unreadText?: (time: string) => string;
	children?: ReactNode;
};

function LayerEntry(props: LayerEntryProps) {
	const { open, label, swatch, checked, onChange, summary, count, emptyText, unreadText, children } = props;
	const loaded = summary.dataAsOf !== null;
	const { attribution, coverage } = summary;
	// What the details below warn about: a failed fetch, hours not read yet, or polling behind.
	const warning = summary.failed || Boolean(coverage && unreadText && coverage.unread !== "none") || coverage?.behind;

	return (
		<section className="space-y-1 border-t border-zinc-200 pt-2">
			<label className="flex items-center gap-2">
				<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
				<span className="size-3 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
				<span className="flex-1 font-medium">{label}</span>
				{!open && warning && (
					<span className="text-amber-700" title="This layer has a data warning; expand the panel for details">
						⚠
					</span>
				)}
				{loaded && <span className="text-zinc-600 tabular-nums">{count}</span>}
			</label>

			<div className={`space-y-1 pl-5 text-xs text-zinc-600 ${open ? "" : "hidden"}`}>
				{summary.loading && <p>Loading…</p>}
				{summary.failed && !loaded && <p className="text-red-700">Couldn&apos;t load this layer.</p>}
				{summary.failed && loaded && (
					<p className="text-amber-800">
						Couldn&apos;t refresh; showing data as of {formatTime(summary.dataAsOf!)}.
					</p>
				)}
				{/* Nothing in hours the source hasn't read isn't "no activity": that case gets the unread note. */}
				{loaded && summary.inWindow === 0 && coverage?.unread !== "all" && <p>{emptyText}</p>}
				{coverage && coverage.unread !== "none" && unreadText && (
					<p className="text-amber-800">
						{coverage.readThrough === null
							? "Nothing in this window has been read from the source."
							: coverage.behind
								? `Nothing read after ${formatTime(coverage.readThrough)}: live polling is behind.`
								: unreadText(formatTime(coverage.readThrough))}
					</p>
				)}
				{coverage && (
					<p className="text-[11px] text-zinc-500">
						{coverage.statement}
						{/* When behind, the statement already says how long it's been. */}
						{coverage.lastPollAt !== null && !coverage.behind && ` Last poll ${formatTime(coverage.lastPollAt)}.`}
					</p>
				)}
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

const COLOR_OPTIONS: [WeatherColor | null, string][] = [
	[null, "None"],
	...(Object.keys(WEATHER_COLORS) as WeatherColor[]).map((color): [WeatherColor, string] => [
		color,
		WEATHER_COLORS[color].label,
	]),
];

function WeatherControls({ view, onChange }: { view: WeatherView; onChange: (view: WeatherView) => void }) {
	return (
		<div className="space-y-2 text-zinc-700">
			<label className="flex items-center gap-2">
				<input type="checkbox" checked={view.wind} onChange={(event) => onChange({ ...view, wind: event.target.checked })} />
				Wind
			</label>
			{view.wind && (
				<div className="space-y-1 text-zinc-600">
					<p>Arrows point where the wind blows; more streaks and bigger for stronger wind.</p>
					<ul className="grid grid-cols-2 gap-x-2 gap-y-0.5">
						{WIND_ICONS.map(({ name, label, url }) => (
							<li key={name} className="flex items-center gap-1">
								{/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URL */}
								<img src={url} alt="" className="size-5" />
								{label}
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="space-y-1">
				<p>Colour points by</p>
				<div className="flex rounded-md border border-zinc-200 p-0.5" role="group" aria-label="Colour weather points by">
					{COLOR_OPTIONS.map(([color, label]) => (
						<button
							key={label}
							type="button"
							aria-pressed={color === view.color}
							onClick={() => onChange({ ...view, color })}
							className={`flex-1 rounded px-1 py-0.5 ${
								color === view.color ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
							}`}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			{view.color && <ColorScale color={view.color} />}
			<p className="flex items-center gap-1 text-zinc-600">
				<span className="size-2.5 rounded-full" style={{ backgroundColor: NO_VALUE_COLOR }} />
				{view.color ? "No model value" : "Sample point; without an arrow, no modeled wind"}
			</p>
		</div>
	);
}

// The stops are evenly spaced, so a CSS gradient through their colours matches the map's
// linear interpolation.
function ColorScale({ color }: { color: WeatherColor }) {
	const { label, unit, stops } = WEATHER_COLORS[color];
	const last = stops.length - 1;
	const gradient = `linear-gradient(to right, ${stops.map(([, stop]) => stop).join(", ")})`;

	return (
		<div className="space-y-0.5 text-zinc-600">
			<p>
				{label} ({unit})
			</p>
			<div className="h-2 rounded-sm" style={{ background: gradient }} />
			<div className="flex justify-between tabular-nums">
				{stops.map(([value], index) => (
					<span key={value}>
						{index === 0 ? "≤" : index === last ? "≥" : ""}
						{value}
					</span>
				))}
			</div>
		</div>
	);
}
