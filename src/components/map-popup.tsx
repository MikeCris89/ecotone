"use client";

import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import type { ReactNode } from "react";
import { formatTime } from "@/components/map-panel";
import type { SourceAttribution } from "@/lib/data-sources";
import type { FirmsMapDetails } from "@/lib/firms/map";
import type { InatMapDetails } from "@/lib/inaturalist/map";
import { inatPrecision } from "@/lib/map-layers";
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
};

export function MapPopupContent({ selection, weather }: { selection: MapSelection; weather?: WeatherPopupData }) {
	return (
		<div className="w-64 space-y-2 text-xs text-zinc-900">
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
// reopened, without holding a record much longer than the map layers do.
function useDetails<T>(source: "inaturalist" | "firms", id: number | string) {
	return useQuery({
		queryKey: ["map-details", source, id],
		queryFn: async (): Promise<T> => {
			const response = await fetch(`/api/map/${source}/${encodeURIComponent(id)}`);
			if (!response.ok) throw new Error(`${source} details: HTTP ${response.status}`);
			return (await response.json()).record;
		},
		staleTime: 60_000,
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
	// Only CC-licensed photos are shown; a null license means all rights reserved.
	const showPhoto = data.photoUrl !== null && data.photoLicense !== null;

	return (
		<>
			<header className="flex gap-2">
				{showPhoto && (
					<Image
						src={data.photoUrl!}
						alt={`Photo of ${name}`}
						width={64}
						height={64}
						unoptimized
						className="size-16 rounded object-cover"
					/>
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
				{showPhoto && `Photo © ${data.observer}, ${licenseLabel(data.photoLicense)}.`}
				{data.photoUrl && !showPhoto && "Photo not shown (all rights reserved)."}
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

function WeatherDetails({ point, row, model, attribution }: WeatherPopupData) {
	const [, , , , , elevationM, gridDistanceM, retrievedAt] = point;
	const [, validAt, temperatureC, humidityPct, precipitationMm, windKmh, windDirectionDeg, gustsKmh] = row;

	return (
		<>
			<header>
				<p className="text-zinc-500">Modeled conditions</p>
				<p className="text-sm font-semibold">{formatTime(validAt * 1000)}</p>
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
				<Fact label="Retrieved">{formatTime(retrievedAt * 1000)}</Fact>
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
function formatDate(isoDate: string) {
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
