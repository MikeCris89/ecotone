"use client";

import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { type ReactNode, useEffect, useRef } from "react";
import type { SourceAttribution } from "@/lib/data-sources";
import type { FirmsMapDetails } from "@/lib/firms/map";
import type { InatMapDetails } from "@/lib/inaturalist/map";
import { inatPrecision, LAYER_REFRESH_MINUTES } from "@/lib/map-layers";
import { formatTime, HOUR } from "@/lib/timeline";
import type { WeatherMapPoint, WeatherMapRow } from "@/lib/open-meteo/map";

/**
 * The record a click selected, by ID only: the map looks it up in its current data on each
 * render, so a refresh never leaves the popup showing a stale copy. `more` counts the other
 * records under the click.
 */
export type MapSelection =
	| { source: "inaturalist"; id: number; more: number }
	| { source: "firms"; id: string; more: number }
	| { source: "weather"; id: number; more: number };

/** The weather layer's already-loaded values for the selected point. */
export type WeatherPopupData = {
	point: WeatherMapPoint;
	row: WeatherMapRow;
	model: string;
	attribution: SourceAttribution;
	// The hour the map shows (epoch seconds); `row` can be up to WEATHER_MAX_AGE_HOURS older.
	hourShown: number;
	// When `row` was last retrieved, known only for the point's newest loaded reading.
	retrievedAt: number | null;
};

type MapPopupContentProps = {
	selection: MapSelection;
	weather?: WeatherPopupData;
	// Called whenever the content's size changes, e.g. when details replace "Loading…".
	onResize: () => void;
};

export function MapPopupContent({ selection, weather, onResize }: MapPopupContentProps) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const observer = new ResizeObserver(onResize);
		observer.observe(ref.current!);
		return () => observer.disconnect();
	}, [onResize]);

	return (
		<div ref={ref} className="w-64 space-y-2 text-xs text-zinc-900">
			{selection.source === "inaturalist" && <InatDetails id={selection.id} />}
			{selection.source === "firms" && <FirmsDetails id={selection.id} />}
			{selection.source === "weather" && weather && <WeatherDetails {...weather} />}
			{selection.more > 0 && (
				<p className="border-t border-zinc-200 pt-1 text-zinc-500">
					+{selection.more} more {selection.more === 1 ? "record" : "records"} here; zoom in to pick one.
				</p>
			)}
		</div>
	);
}

// A primary-key lookup per click. A minute of staleTime saves a refetch when the same popup is
// reopened; an open popup refetches on its layer's cadence, so it keeps up with the map.
function useDetails<T>(source: "inaturalist" | "firms", id: number | string) {
	return useQuery({
		queryKey: ["map-details", source, id],
		queryFn: async (): Promise<T> => {
			const response = await fetch(`/api/map/${source}/${encodeURIComponent(id)}`);
			if (!response.ok) throw new Error(`${source} details: HTTP ${response.status}`);
			return (await response.json()).record;
		},
		staleTime: 60_000,
		refetchInterval: LAYER_REFRESH_MINUTES[source].poll * 60_000,
		retry: 1,
	});
}

const QUALITY_LABELS: Record<InatMapDetails["qualityGrade"], string> = {
	research: "Research grade",
	needs_id: "Needs ID",
	casual: "Casual",
};

function InatDetails({ id }: { id: number }) {
	const { data, isPending, isError } = useDetails<InatMapDetails>("inaturalist", id);
	if (isPending) return <p>Loading…</p>;
	if (isError) return <p className="text-red-700">Couldn&apos;t load this recorded observation.</p>;

	const name = data.commonName ?? data.scientificName;

	return (
		<>
			<header className="flex gap-2">
				{/* Only CC-licensed photos are shown. An all-rights-reserved one (null license) gets an
				    empty box linking to the observation, so it's clear a photo exists. */}
				{data.photoUrl !== null && data.photoLicense !== null && (
					<Image
						src={data.photoUrl}
						alt={`Photo of ${name}`}
						width={64}
						height={64}
						unoptimized
						className="size-16 shrink-0 rounded object-cover"
					/>
				)}
				{data.photoUrl !== null && data.photoLicense === null && (
					<a
						href={data.sourceUrl}
						target="_blank"
						rel="noreferrer"
						title="Photo on iNaturalist (all rights reserved)"
						aria-label={`Photo of ${name} on iNaturalist (all rights reserved)`}
						className="flex size-16 shrink-0 items-center justify-center rounded bg-zinc-100 text-lg text-zinc-400 hover:bg-zinc-200"
					>
						↗
					</a>
				)}
				<div>
					<p className="text-zinc-500">Recorded observation</p>
					<p className="text-sm font-semibold">{name}</p>
					{data.commonName && <p className="italic">{data.scientificName}</p>}
				</div>
			</header>
			<Facts>
				<Fact label="Observed">
					{data.observedAt
						? formatTime(Date.parse(data.observedAt))
						: `${formatDate(data.observedOn)}, no time recorded`}
				</Fact>
				<Fact label="Uploaded">{formatTime(Date.parse(data.uploadedAt))}</Fact>
				<Fact label="Retrieved">{formatTime(Date.parse(data.retrievedAt))}</Fact>
				<Fact label="Location">{inatLocation(data.positionalAccuracyM, data.obscured)}</Fact>
				<Fact label="Quality">{QUALITY_LABELS[data.qualityGrade]}</Fact>
			</Facts>
			<p className="text-[11px] text-zinc-500">
				Observation by {data.observer}, {licenseLabel(data.license)}.{" "}
				{data.photoUrl && `Photo © ${data.observer}, ${licenseLabel(data.photoLicense)}.`}
			</p>
			<SourceLink href={data.sourceUrl}>View on iNaturalist</SourceLink>
		</>
	);
}

function inatLocation(accuracy: number | null, obscured: boolean) {
	if (obscured) return "Obscured, randomized within a ~0.2° cell";
	if (accuracy === null) return "Positional accuracy unknown";
	return `±${formatDistance(accuracy)} (${inatPrecision(accuracy, obscured)})`;
}

const SATELLITE_LABELS: Record<FirmsMapDetails["satellite"], string> = {
	snpp: "Suomi NPP",
	noaa20: "NOAA-20",
	noaa21: "NOAA-21",
};
// The standard product's fire types, by code.
const FIRE_TYPE_LABELS = ["Presumed vegetation fire", "Active volcano", "Other static land source", "Offshore"];

function FirmsDetails({ id }: { id: string }) {
	const { data, isPending, isError } = useDetails<FirmsMapDetails>("firms", id);
	if (isPending) return <p>Loading…</p>;
	if (isError) return <p className="text-red-700">Couldn&apos;t load this satellite thermal detection.</p>;

	return (
		<>
			<header>
				<p className="text-zinc-500">Satellite thermal detection</p>
				<p className="text-sm font-semibold">
					{SATELLITE_LABELS[data.satellite]} VIIRS, {data.daynight} pass
				</p>
			</header>
			<Facts>
				<Fact label="Acquired">{formatTime(Date.parse(data.acquiredAt))}</Fact>
				<Fact label="First retrieved">{formatTime(Date.parse(data.firstRetrievedAt))}</Fact>
				<Fact label="Retrieved">{formatTime(Date.parse(data.retrievedAt))}</Fact>
				<Fact label="Confidence">{data.confidence}</Fact>
				<Fact label="Radiative power">{data.frpMw} MW</Fact>
				<Fact label="Brightness">{data.brightTi4K} K</Fact>
				<Fact label="Pixel">
					{data.scanKm} × {data.trackKm} km
				</Fact>
				<Fact label="Type">{data.fireType === null ? "Unclassified" : FIRE_TYPE_LABELS[data.fireType]}</Fact>
			</Facts>
			{data.fireType === null && (
				<p className="text-[11px] text-zinc-500">
					Near-real-time detections aren&apos;t classified and can include industrial or other static heat sources.
				</p>
			)}
			<SourceLink href={data.sourceUrl}>Open in the FIRMS Fire Map</SourceLink>
		</>
	);
}

const MODEL_LABELS: Record<string, string> = { ncep_hrrr_conus: "NOAA HRRR" };

function WeatherDetails({ point, row, model, attribution, hourShown, retrievedAt }: WeatherPopupData) {
	// The grid cell comes from the point's newest reading; it hasn't varied between a point's
	// readings in the stored data, so it holds for earlier readings too.
	const [, , , , , elevationM, gridDistanceM] = point;
	const [, validAt, temperatureC, humidityPct, precipitationMm, windKmh, windDirectionDeg, gustsKmh] = row;
	const ageHours = Math.round((hourShown - validAt) / HOUR);

	return (
		<>
			<header>
				<p className="text-zinc-500">Modeled conditions</p>
				<p className="text-sm font-semibold">{formatTime(validAt * 1000)}</p>
				{ageHours > 0 && (
					<p className="text-amber-800">
						Reading from {formatTime(validAt * 1000)}, {ageHours} h before the hour shown. No reading for{" "}
						{formatTime(hourShown * 1000)} is loaded.
					</p>
				)}
			</header>
			<Facts>
				<Fact label="Temperature">{withUnit(temperatureC, "°C")}</Fact>
				<Fact label="Humidity">{withUnit(humidityPct, "%")}</Fact>
				<Fact label="Precipitation">{withUnit(precipitationMm, " mm")} over the hour</Fact>
				<Fact label="Wind">
					{withUnit(windKmh, " km/h")}
					{windKmh !== null && windDirectionDeg !== null && ` from ${windDirectionDeg}°`}
				</Fact>
				<Fact label="Gusts">{withUnit(gustsKmh, " km/h")}</Fact>
				<Fact label="Model">{MODEL_LABELS[model] ?? model}</Fact>
				<Fact label="Grid cell">
					{formatDistance(gridDistanceM)} from the sample point, {elevationM} m elevation
				</Fact>
				<Fact label="Retrieved">
					{retrievedAt === null ? "Not loaded for earlier hours" : formatTime(retrievedAt * 1000)}
				</Fact>
			</Facts>
			<p className="text-[11px] text-zinc-500">
				Values describe one model grid cell, not a measurement at this spot.
			</p>
			<SourceLink href={attribution.homepageUrl}>{attribution.name}</SourceLink>
		</>
	);
}

// Null means the model had no value, never zero.
function withUnit(value: number | null, unit: string) {
	return value === null ? "no value" : `${value}${unit}`;
}

function formatDistance(metres: number) {
	return metres < 1_000 ? `${metres} m` : `${(metres / 1_000).toFixed(1)} km`;
}

// An observer's local calendar date, printed as that same date whatever the browser's zone.
export function formatDate(isoDate: string) {
	return new Date(`${isoDate}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// iNaturalist license codes: cc0, cc-by, cc-by-nc, ... Null means all rights reserved.
function licenseLabel(code: string | null) {
	if (code === null) return "all rights reserved";
	if (code === "cc0") return "CC0";
	return code.toUpperCase().replace(/^CC-/, "CC ");
}

function Facts({ children }: { children: ReactNode }) {
	return <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-zinc-500">{label}</dt>
			<dd>{children}</dd>
		</>
	);
}

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a className="inline-block font-medium text-blue-700 underline" href={href} target="_blank" rel="noreferrer">
			{children} ↗
		</a>
	);
}
