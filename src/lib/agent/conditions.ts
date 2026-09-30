// Agent tool: modeled conditions (Open-Meteo) near a place over a range, from the nearest sample
// point with readings. Always says how far the model's grid cell is from the place asked about.
import { z } from "zod";
import {
	type Coverage,
	type Evidence,
	getCoverage,
	insufficientCoverage,
	isComplete,
	rangeSchema,
	resolveRange,
	type ToolResult,
} from "@/lib/agent/contract";
import { sql } from "@/lib/db";
import { CALIFORNIA_TIME_ZONE, formatTime, HOUR, WEATHER_MAX_AGE_HOURS, weatherLookback } from "@/lib/timeline";
import { localDate, nextDate, startOfLocalDate } from "@/lib/dates";

// The live grid keeps every point in California within ~35 km of a sample point; past this, the
// nearest grid cell says little about the place.
export const MAX_GRID_DISTANCE_KM = 50;
// Up to two days are returned hour by hour; longer ranges by day.
const MAX_HOURLY_READINGS = 48;

export const getConditionsInput = z.object({
	location: z.object({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90) }),
	range: rangeSchema,
});

type Reading = {
	validAt: Date;
	temperatureC: number | null;
	relativeHumidityPct: number | null;
	precipitationMm: number | null;
	windSpeedKmh: number | null;
	windFromDeg: number | null;
	windGustsKmh: number | null;
	url: string;
	retrievedAt: Date;
};

type Stats = { min: number; max: number; mean: number } | null;
type Hour = Omit<Reading, "validAt" | "url" | "retrievedAt"> & { at: string };

export type Conditions = {
	model: string;
	// The grid cell the values describe: its centre, elevation, and distance from the queried place.
	gridCell: { longitude: number; latitude: number; elevationM: number; distanceKm: number };
	// Hours with a reading (0 when falling back), of the hour marks in the range: the hours that
	// could have one.
	hours: number;
	requestedHours: number;
	// Set when the range has no readings (not stored, or not read yet): the values are the point's
	// latest reading before the range's end instead. Its age counts from the range's last hour;
	// `current` when the map would still show it for that hour (WEATHER_MAX_AGE_HOURS).
	fallback: { validAt: string; ageHours: number; current: boolean } | null;
	summary: {
		temperatureC: Stats;
		relativeHumidityPct: Stats;
		windSpeedKmh: Stats;
		windGustsMaxKmh: number | null;
		// A total over the hours with a value: a missing hour is unknown, not zero. Null when none has one.
		precipitation: { totalMm: number | null; hoursWithValue: number };
		// Where the wind mostly blew from (speed-weighted), as a compass point.
		prevailingWindFrom: string | null;
	};
	driestHour: Hour | null;
	gustiestHour: Hour | null;
	// Hour by hour for ranges up to 48 readings, otherwise day by day (California dates).
	hourly: Hour[] | null;
	daily:
		| {
				date: string;
				// Hours with a reading, of the day's hours in the range, of the hours the date has. A day
				// cut by the range's start or end has hoursInRange < hoursInDay with nothing missing; it's
				// partial only when hours < hoursInRange. Either way its values cover only its readings
				// (e.g. only night hours understate the high).
				hours: number;
				hoursInRange: number;
				hoursInDay: number;
				partial: boolean;
				temperatureMinC: number | null;
				temperatureMaxC: number | null;
				humidityMinPct: number | null;
				windMaxKmh: number | null;
				gustMaxKmh: number | null;
				// Null unless every hour of the day in the range has a reading with a value.
				precipitationMm: number | null;
		  }[]
		| null;
};

export async function getConditions(
	input: z.input<typeof getConditionsInput>,
	now = new Date(),
): Promise<ToolResult<Conditions>> {
	const { location, range } = getConditionsInput.parse(input);
	// A point as a bbox: coverage counts the runs whose bbox contains it.
	const area = { west: location.longitude, south: location.latitude, east: location.longitude, north: location.latitude };
	const window = resolveRange(range, now);
	const empty = (reason: string, coverage: Coverage): ToolResult<Conditions> => ({
		result: null,
		evidence: [],
		coverage,
		limitations: [],
		insufficient: { reason },
	});
	if (!window) {
		return empty("The range starts in the future, so there are no stored conditions for it yet.", {
			area,
			range,
			filters: {},
			complete: false,
			sources: [],
		});
	}

	const sources = await getCoverage(["open-meteo"], area, window, now);
	const coverage: Coverage = {
		area,
		range: { start: window.start.toISOString(), end: window.end.toISOString() },
		filters: {},
		complete: isComplete(sources),
		sources,
	};
	// Unlike the counting tools, a range read under MIN_READ_FRACTION is answered from the hours with
	// readings, saying how many (decisions.md, 36). A range no run read, or with no readings, gets the
	// fallback below when it reaches the present (the hour's poll may not have run yet), and is
	// refused otherwise.
	const insufficient = insufficientCoverage(sources);
	const neverRead = sources[0].readHours === 0;

	const place = sql`extensions.st_setsrid(extensions.st_makepoint(${location.longitude}, ${location.latitude}), 4326)::extensions.geography`;
	// The nearest sample point with readings in the range, and its most common model there.
	const [inRange] = neverRead
		? []
		: await sql<{ id: string; model: string }[]>`
				select p.id, (
					select mode() within group (order by r.model)
					from weather_readings r
					where r.point_id = p.id and r.valid_at >= ${window.start} and r.valid_at < ${window.end}
				) as model
				from weather_points p
				where exists (
					select 1 from weather_readings r
					where r.point_id = p.id and r.valid_at >= ${window.start} and r.valid_at < ${window.end}
				)
				order by p.location <-> ${place}
				limit 1
			`;
	// None, for a range that reaches the present ("right now" before the hour's poll, or a feed that's
	// behind): the nearest point's latest reading before the range's end, read as a one-hour range of
	// its own. A past range with no readings is refused: another period's reading doesn't answer it.
	const reachesNow = window.end.getTime() >= now.getTime() - WEATHER_MAX_AGE_HOURS * HOUR * 1000;
	const [newest] = inRange || !reachesNow
		? []
		: await sql<{ id: string; model: string; validAt: Date }[]>`
				select p.id, r.model, r.valid_at as "validAt"
				from weather_points p
				join lateral (
					select model, valid_at from weather_readings
					where point_id = p.id and valid_at < ${window.end}
					order by valid_at desc
					limit 1
				) r on true
				order by p.location <-> ${place}
				limit 1
			`;
	// Refused: no reading to answer from (a past range, or nothing stored before a present one), or
	// readings in a range no run over this area read.
	if (!inRange && insufficient && (!newest || newest.validAt >= window.start)) {
		return { result: null, evidence: [], coverage, limitations: [], insufficient };
	}
	const point = inRange ?? newest;
	if (!point) return empty("No modeled conditions are stored for this range.", coverage);
	let fallback: Conditions["fallback"] = null;
	let readFrom = window;
	if (newest) {
		const lastHour = lastHourOf(window.end);
		const validAt = newest.validAt.getTime() / 1000;
		fallback = {
			validAt: newest.validAt.toISOString(),
			ageHours: Math.max(0, lastHour - validAt) / HOUR,
			current: validAt >= weatherLookback(lastHour).start,
		};
		readFrom = { start: newest.validAt, end: new Date((validAt + HOUR) * 1000) };
	}

	const [readings, [cell], [attribution]] = await Promise.all([
		sql<Reading[]>`
			select
				valid_at as "validAt",
				temperature_c as "temperatureC",
				relative_humidity_pct as "relativeHumidityPct",
				precipitation_mm as "precipitationMm",
				wind_speed_kmh as "windSpeedKmh",
				wind_direction_deg as "windFromDeg",
				wind_gusts_kmh as "windGustsKmh",
				source_url as url,
				retrieved_at as "retrievedAt"
			from weather_readings
			where point_id = ${point.id} and model = ${point.model}
				and valid_at >= ${readFrom.start} and valid_at < ${readFrom.end}
			order by valid_at
		`,
		// The newest reading's grid cell (constant per point in practice, not enforced).
		sql<{ longitude: number; latitude: number; elevationM: number; distanceM: number }[]>`
			select
				extensions.st_x(grid_location::extensions.geometry) as longitude,
				extensions.st_y(grid_location::extensions.geometry) as latitude,
				elevation_m as "elevationM",
				extensions.st_distance(grid_location, ${place}) as "distanceM"
			from weather_readings
			where point_id = ${point.id} and model = ${point.model}
				and valid_at >= ${readFrom.start} and valid_at < ${readFrom.end}
			order by valid_at desc
			limit 1
		`,
		sql<{ license: string | null; name: string }[]>`select license, name from data_sources where source = 'open-meteo'`,
	]);

	const distanceKm = Number((cell.distanceM / 1000).toFixed(1));
	if (distanceKm > MAX_GRID_DISTANCE_KM) {
		return empty(
			`The nearest modeled grid cell with readings is ${distanceKm} km away (more than ${MAX_GRID_DISTANCE_KM} km), ` +
				"so it can't stand in for this place.",
			coverage,
		);
	}

	const hour = (reading: Reading): Hour => ({
		at: reading.validAt.toISOString(),
		temperatureC: reading.temperatureC,
		relativeHumidityPct: reading.relativeHumidityPct,
		precipitationMm: reading.precipitationMm,
		windSpeedKmh: reading.windSpeedKmh,
		windFromDeg: reading.windFromDeg,
		windGustsKmh: reading.windGustsKmh,
	});
	const extreme = (pick: (reading: Reading) => number | null, lowest: boolean) =>
		readings
			.filter((reading) => pick(reading) !== null)
			.reduce<Reading | null>(
				(best, reading) =>
					!best || (lowest ? pick(reading)! < pick(best)! : pick(reading)! > pick(best)!) ? reading : best,
				null,
			);
	const driest = extreme((reading) => reading.relativeHumidityPct, true);
	const gustiest = extreme((reading) => reading.windGustsKmh, false);
	const latest = readings.at(-1)!;
	const requestedHours = hourMarks(window.start.getTime(), window.end.getTime());
	const days = readings.length <= MAX_HOURLY_READINGS ? null : daily(readings, window);

	// Newest first, each reading once: the latest hour, then the driest and gustiest.
	const evidenceReadings = [...new Set([latest, driest, gustiest].filter((reading) => reading !== null))];
	const evidence: Evidence[] = evidenceReadings.map((reading) => ({
		source: "open-meteo",
		// One record per reading, so each can be cited on its own.
		id: `${point.id}:${reading.validAt.toISOString()}`,
		url: reading.url,
		label: `Modeled conditions (${point.model}), ${distanceKm} km from the place asked about`,
		longitude: cell.longitude,
		latitude: cell.latitude,
		observedAt: reading.validAt.toISOString(),
		retrievedAt: reading.retrievedAt.toISOString(),
		license: attribution.license,
		attribution: attribution.name,
	}));

	return {
		result: {
			model: point.model,
			gridCell: { longitude: cell.longitude, latitude: cell.latitude, elevationM: cell.elevationM, distanceKm },
			hours: fallback ? 0 : readings.length,
			requestedHours,
			fallback,
			summary: {
				temperatureC: stats(readings.map((reading) => reading.temperatureC)),
				relativeHumidityPct: stats(readings.map((reading) => reading.relativeHumidityPct)),
				windSpeedKmh: stats(readings.map((reading) => reading.windSpeedKmh)),
				windGustsMaxKmh: stats(readings.map((reading) => reading.windGustsKmh))?.max ?? null,
				precipitation: {
					totalMm: sum(readings.map((reading) => reading.precipitationMm)),
					hoursWithValue: present(readings.map((reading) => reading.precipitationMm)).length,
				},
				prevailingWindFrom: prevailingWindFrom(readings),
			},
			driestHour: driest && hour(driest),
			gustiestHour: gustiest && hour(gustiest),
			hourly: days ? null : readings.map(hour),
			daily: days,
		},
		evidence,
		coverage,
		limitations: [
			...(fallback ? [fallbackLimitation(fallback)] : []),
			...(!fallback && readings.length < requestedHours
				? [missingHoursLimitation(readings.length, requestedHours, latest.validAt, window.end)]
				: []),
			...(days?.some((day) => day.partial) ? [CONDITIONS_LIMITATIONS.partialDays] : []),
			...(days?.some((day) => day.hoursInRange < day.hoursInDay) ? [CONDITIONS_LIMITATIONS.cutDays] : []),
			`Modeled conditions from ${point.model} for one grid cell whose centre is ${distanceKm} km from the place asked about; ` +
				"not measured there. Terrain between them can make real conditions differ.",
			"Wind direction is where the wind blows from. Gusts are the strongest over each hour; precipitation is each hour's total.",
			"The newest hours can still be revised by later model runs.",
			"Reading links only work while Open-Meteo still serves that hour (about a week for HRRR).",
		],
	};
}

function fallbackLimitation({ validAt, ageHours, current }: NonNullable<Conditions["fallback"]>) {
	const when = `${formatTime(Date.parse(validAt))}, ${ageHours} h before the range's last hour`;
	return current
		? `No reading is stored for the range yet. These are the latest modeled conditions, valid ${when}: recent enough ` +
				`to count as current (up to ${WEATHER_MAX_AGE_HOURS} h, as on the map).`
		: `The weather feed is behind: no reading is stored for the range, and the latest is from ${when}. These are ` +
				"the last available modeled conditions, not current ones.";
}

// Limitations are shown to users under the answer, so they're plain statements; what the model
// should do with them is in the tool's description.
export const CONDITIONS_LIMITATIONS = {
	partialDays:
		"Some days are missing readings for part of their hours: their highs, lows and gusts cover only the hours with " +
		"readings, and they have no precipitation total.",
	cutDays:
		"The range starts or ends partway through a day, so that day's values cover only its hours inside the range. " +
		"That alone doesn't mean readings are missing.",
};

/** The hour marks in [start, end) (epoch ms): the hours that can have a reading. */
const hourMarks = (start: number, end: number) =>
	Math.max(0, Math.ceil(end / (HOUR * 1000)) - Math.ceil(start / (HOUR * 1000)));

/** The start of the range's last hour, in epoch seconds. */
const lastHourOf = (end: Date) => Math.floor((end.getTime() - 1) / (HOUR * 1000)) * HOUR;

// The summaries only see the hours with readings: a stretch read only at night understates the high
// temperature and overstates the lowest humidity, and the driest or gustiest hour may be missing.
function missingHoursLimitation(hours: number, requestedHours: number, latestAt: Date, end: Date) {
	const ageHours = (lastHourOf(end) - latestAt.getTime() / 1000) / HOUR;
	return (
		`Readings for ${hours} of ${requestedHours} hours in the range; the rest aren't stored. The summary, the driest ` +
		"and gustiest hours and the prevailing wind cover only those hours, so they can miss the range's extremes." +
		(ageHours > 0
			? ` The newest reading is from ${formatTime(latestAt.getTime())}, ${ageHours} h before the range's last hour.`
			: "")
	);
}

const present = (values: (number | null)[]) => values.filter((value) => value !== null);
const round = (value: number) => Number(value.toFixed(1));

function stats(values: (number | null)[]): Stats {
	const known = present(values);
	if (known.length === 0) return null;
	return {
		min: round(Math.min(...known)),
		max: round(Math.max(...known)),
		mean: round(known.reduce((total, value) => total + value, 0) / known.length),
	};
}

function sum(values: (number | null)[]): number | null {
	const known = present(values);
	return known.length === 0 ? null : round(known.reduce((total, value) => total + value, 0));
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** The speed-weighted mean of where the wind blew from, as a compass point; null when calm or unknown. */
export function prevailingWindFrom(readings: Pick<Reading, "windSpeedKmh" | "windFromDeg">[]): string | null {
	let x = 0;
	let y = 0;
	for (const { windSpeedKmh: speed, windFromDeg: from } of readings) {
		if (speed === null || from === null) continue;
		const radians = (from * Math.PI) / 180;
		x += speed * Math.sin(radians);
		y += speed * Math.cos(radians);
	}
	if (Math.hypot(x, y) < 1e-9) return null;
	const degrees = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
	return COMPASS[Math.round(degrees / 22.5) % 16];
}

function daily(readings: Reading[], range: { start: Date; end: Date }): NonNullable<Conditions["daily"]> {
	const byDate = new Map<string, Reading[]>();
	for (const reading of readings) {
		const date = localDate(reading.validAt, CALIFORNIA_TIME_ZONE);
		byDate.set(date, [...(byDate.get(date) ?? []), reading]);
	}
	return [...byDate].map(([date, day]) => {
		const dayStart = startOfLocalDate(date, CALIFORNIA_TIME_ZONE).getTime();
		const dayEnd = startOfLocalDate(nextDate(date), CALIFORNIA_TIME_ZONE).getTime();
		const hoursInRange = hourMarks(Math.max(dayStart, range.start.getTime()), Math.min(dayEnd, range.end.getTime()));
		const partial = day.length < hoursInRange;
		return {
			date,
			hours: day.length,
			hoursInRange,
			// 23 or 25 on the days clocks change.
			hoursInDay: hourMarks(dayStart, dayEnd),
			partial,
			temperatureMinC: stats(day.map((reading) => reading.temperatureC))?.min ?? null,
			temperatureMaxC: stats(day.map((reading) => reading.temperatureC))?.max ?? null,
			humidityMinPct: stats(day.map((reading) => reading.relativeHumidityPct))?.min ?? null,
			windMaxKmh: stats(day.map((reading) => reading.windSpeedKmh))?.max ?? null,
			gustMaxKmh: stats(day.map((reading) => reading.windGustsKmh))?.max ?? null,
			precipitationMm:
				partial || day.some((reading) => reading.precipitationMm === null)
					? null
					: sum(day.map((reading) => reading.precipitationMm)),
		};
	});
}
