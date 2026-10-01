"use client";

import { type KeyboardEvent, memo, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { DETECTION_COLOR, OBSERVATION_COLOR } from "@/components/map-colors";
import { type IncompleteWindow, type RowShading, rowShading } from "@/lib/coverage";
import type { SourceFreshness } from "@/lib/freshness";
import type { TimeWindow } from "@/lib/map-layers";
import {
	CALIFORNIA_TIME_ZONE,
	type DayCount,
	formatTime,
	HOUR,
	hourAxis,
	lastHour,
	localMidnights,
	nextPlaybackHour,
	PLAYBACK_HOURS_PER_SECOND,
	PLAYBACK_SPEEDS,
	playbackStart,
	TRAILING_HOURS,
	WEATHER_MAX_AGE_HOURS,
} from "@/lib/timeline";

const dayFormat = new Intl.DateTimeFormat([], { timeZone: CALIFORNIA_TIME_ZONE, month: "short", day: "numeric" });
const formatSeconds = (epochSeconds: number) => formatTime(epochSeconds * 1000);

// Drawn behind the parts of a row with no data (not loaded, or not read from the source yet), so
// they don't read as zero activity.
const NOT_LOADED_COLOR = "#e4e4e7";
// Behind hours that were read but are likely incomplete.
const INCOMPLETE_HATCH = "repeating-linear-gradient(135deg, rgb(217 119 6 / 0.35) 0 2px, transparent 2px 6px)";
const INCOMPLETE_TITLES: Record<IncompleteWindow["reason"], string> = {
	partial: "Likely incomplete: read only partly",
	"publishing-lag": "Likely incomplete: may still fill in as satellite passes are published",
	"upload-lag": "Likely incomplete: uploads still arriving",
};

type TimelineProps = {
	window: TimeWindow;
	// The start of the handle's hour (epoch seconds), or null for the whole window, and the span the
	// map shows for it, which can start before `window`.
	hour: number | null;
	span: TimeWindow | null;
	onHourChange: (hour: number | null) => void;
	// Per hour of the window's axis (hourAxis).
	observations: number[];
	detections: number[];
	dateOnly: DayCount[];
	// The time range each layer's loaded rows cover, null before a layer loads.
	observationsLoaded: TimeWindow | null;
	detectionsLoaded: TimeWindow | null;
	// What each source has read (/api/freshness), null until it loads.
	observationsCoverage: SourceFreshness | null;
	detectionsCoverage: SourceFreshness | null;
};

// Along the bottom edge, under the panel; the right side stays free for the chat. Memoized, since
// the map re-renders on every mouse move over it.
export const Timeline = memo(function Timeline(props: TimelineProps) {
	const { window, hour, span, onHourChange, observations, detections, dateOnly } = props;
	const { first, count } = hourAxis(window);
	const last = lastHour(window);
	const midnights = useMemo(() => localMidnights(window), [window]);
	const { observationsLoaded, detectionsLoaded, observationsCoverage, detectionsCoverage } = props;
	const observationsShading = useMemo(
		() => rowShading({ start: first, end: first + count * HOUR }, observationsLoaded, observationsCoverage),
		[first, count, observationsLoaded, observationsCoverage],
	);
	const detectionsShading = useMemo(
		() => rowShading({ start: first, end: first + count * HOUR }, detectionsLoaded, detectionsCoverage),
		[first, count, detectionsLoaded, detectionsCoverage],
	);
	const plotRef = useRef<HTMLDivElement>(null);

	// Pointer events can fire several times per frame. Only the latest position per frame reaches
	// the map, and an unchanged hour doesn't re-render at all, so MapLibre gets at most one
	// setFilter per layer per frame.
	const frame = useRef(0);
	const pending = useRef<number | null>(null);
	const scheduleHour = (next: number) => {
		pending.current = next;
		if (frame.current) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			onHourChange(pending.current);
		});
	};
	// Buttons and keys apply at once, dropping a drag position still waiting for its frame, which
	// would otherwise land after them and undo e.g. "Whole window".
	const setHourNow = (next: number | null) => {
		cancelAnimationFrame(frame.current);
		frame.current = 0;
		onHourChange(next);
	};
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	// Playback moves the handle through the same onHourChange as a drag, one step per timer tick.
	// Each step waits for its render before scheduling the next, so a slow frame delays playback
	// rather than queueing steps, and the step itself waits for an animation frame, which a hidden
	// tab doesn't get: playback halts there instead of running unseen.
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
	useEffect(() => {
		if (!playing || hour === null) return;
		let stepFrame = 0;
		const timer = setTimeout(() => {
			stepFrame = requestAnimationFrame(() => {
				const next = nextPlaybackHour(hour, window);
				if (next === null) setPlaying(false);
				else onHourChange(next);
			});
		}, 1000 / (PLAYBACK_HOURS_PER_SECOND * speed));
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(stepFrame);
		};
	}, [playing, hour, window, speed, onHourChange]);
	const play = () => {
		setPlaying(true);
		setHourNow(playbackStart(hour, window));
	};
	// Any other handle movement pauses first, so playback never fights the viewer for the handle.
	const pause = () => setPlaying(false);

	const hourAt = (clientX: number) => {
		const rect = plotRef.current!.getBoundingClientRect();
		const index = Math.floor(((clientX - rect.left) / rect.width) * count);
		return first + Math.min(Math.max(index, 0), count - 1) * HOUR;
	};
	const onPointer = (event: PointerEvent<HTMLDivElement>) => {
		if (event.type === "pointerdown") {
			event.currentTarget.setPointerCapture(event.pointerId);
			pause();
		} else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		scheduleHour(hourAt(event.clientX));
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === " ") {
			event.preventDefault();
			return playing ? pause() : play();
		}
		const current = hour ?? last;
		const next = {
			ArrowLeft: Math.max(current - HOUR, first),
			ArrowRight: Math.min(current + HOUR, last),
			Home: first,
			End: last,
		}[event.key];
		if (next !== undefined) {
			event.preventDefault();
			pause();
			setHourNow(next);
		} else if (event.key === "Escape") {
			pause();
			setHourNow(null);
		}
	};

	// Positions on the axis, as percentages of its width, clamped to it: a span can start before it.
	const at = (time: number) => Math.min(Math.max(((time - first) / (count * HOUR)) * 100, 0), 100);

	return (
		<div className="pointer-events-auto w-full shrink-0 space-y-2 rounded-lg bg-white/95 p-2 text-xs text-zinc-700 shadow-md md:p-3">
			{/* On narrow screens the buttons get their own row above a short span; from md up, one row. */}
			<div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
				<div className="flex items-center gap-2 md:contents">
					<button
						type="button"
						onClick={playing ? pause : play}
						className="w-20 shrink-0 rounded border border-zinc-200 px-2 py-1 text-zinc-600 hover:bg-zinc-100"
					>
						{playing ? "❚❚ Pause" : "▶ Play"}
					</button>
					<div className="flex shrink-0 rounded-md border border-zinc-200 p-0.5" role="group" aria-label="Playback speed">
						{PLAYBACK_SPEEDS.map((option) => (
							<button
								key={option}
								type="button"
								aria-pressed={option === speed}
								onClick={() => setSpeed(option)}
								className={`rounded px-1.5 ${
									option === speed ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
								}`}
							>
								{option}×
							</button>
						))}
					</div>
					<button
						type="button"
						aria-pressed={hour === null}
						onClick={() => {
							pause();
							setHourNow(null);
						}}
						className={`shrink-0 rounded border border-zinc-200 px-2 py-1 ${
							hour === null ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
						}`}
					>
						Whole window
					</button>
				</div>
				{span && hour !== null ? (
					<>
						<p className="hidden md:block">
							Showing {formatSeconds(span.start)} – {formatSeconds(span.end)}: the {TRAILING_HOURS} hours to the
							handle, older records fainter. Modeled conditions for the hour from {formatSeconds(hour)}, or the latest
							reading up to {WEATHER_MAX_AGE_HOURS} h earlier, faded.
						</p>
						<p className="md:hidden">
							Showing {formatSeconds(span.start)} – {formatSeconds(span.end)}
						</p>
					</>
				) : (
					<>
						<p className="hidden md:block">
							Showing the whole window, with modeled conditions for its newest hour. Drag along the timeline, use the
							arrow keys, or press play to step through it by the hour.
						</p>
						<p className="md:hidden">Showing the whole window. Drag the bars or press play.</p>
					</>
				)}
			</div>

			<div className="flex gap-2">
				<div className="hidden w-44 shrink-0 space-y-1 text-zinc-600 md:block">
					<p className="flex h-8 items-center">Recorded observations / hour</p>
					<p className="flex h-3 items-center text-[11px]">Date only, no time recorded / day</p>
					<p className="flex h-8 items-center">Satellite thermal detections / hour</p>
					<p className="text-[11px] leading-4 text-zinc-500">
						Scaled per row.{" "}
						<span className="inline-block size-2.5 align-middle" style={{ backgroundColor: NOT_LOADED_COLOR }} /> not
						loaded or not read yet,{" "}
						<span className="inline-block size-2.5 align-middle" style={{ backgroundImage: INCOMPLETE_HATCH }} /> likely
						incomplete
					</p>
				</div>

				<div className="min-w-0 flex-1">
					{/* Narrow screens: a one-line key instead of the label column. */}
					<p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-600 md:hidden">
						<span className="flex items-center gap-1">
							<span className="size-2.5" style={{ backgroundColor: OBSERVATION_COLOR }} />
							Recorded observations / h
						</span>
						<span className="flex items-center gap-1">
							<span className="size-2.5" style={{ backgroundColor: DETECTION_COLOR }} />
							Satellite thermal detections / h
						</span>
						<span className="flex items-center gap-1">
							<span className="size-2.5" style={{ backgroundColor: NOT_LOADED_COLOR }} />
							Not loaded or not read yet
						</span>
						<span className="flex items-center gap-1">
							<span className="size-2.5" style={{ backgroundImage: INCOMPLETE_HATCH }} />
							Likely incomplete
						</span>
					</p>
					<div
						ref={plotRef}
						role="slider"
						tabIndex={0}
						aria-label="Timeline hour"
						aria-valuemin={first}
						aria-valuemax={last}
						aria-valuenow={hour ?? last}
						aria-valuetext={hour === null ? "Whole window" : formatSeconds(hour)}
						onPointerDown={onPointer}
						onPointerMove={onPointer}
						onKeyDown={onKeyDown}
						className="relative cursor-ew-resize touch-none space-y-1 select-none focus-visible:outline-2 focus-visible:outline-zinc-900"
					>
						<HourBars
							counts={observations}
							first={first}
							shading={observationsShading}
							color={OBSERVATION_COLOR}
							noun="recorded observations"
						/>
						<DayBands days={dateOnly} first={first} count={count} shading={observationsShading} />
						<HourBars
							counts={detections}
							first={first}
							shading={detectionsShading}
							color={DETECTION_COLOR}
							noun="satellite thermal detections"
						/>

						<div className="pointer-events-none absolute inset-0">
							{midnights.map((midnight) => (
								<div
									key={midnight}
									className="absolute inset-y-0 border-l border-zinc-300"
									style={{ left: `${at(midnight)}%` }}
								/>
							))}
							{span && hour !== null && (
								<>
									<div
										className="absolute inset-y-0 bg-zinc-900/10"
										style={{ left: `${at(span.start)}%`, width: `${at(span.end) - at(span.start)}%` }}
									/>
									<div
										className="absolute -inset-y-1 border-x-2 border-zinc-900"
										style={{ left: `${at(hour)}%`, width: `${at(hour + HOUR) - at(hour)}%` }}
									/>
								</>
							)}
						</div>
					</div>

					<div className="relative h-4 text-zinc-500">
						{midnights.map((midnight) => (
							<span key={midnight} className="absolute pl-1" style={{ left: `${at(midnight)}%` }}>
								{dayFormat.format(midnight * 1000)}
							</span>
						))}
					</div>
				</div>
			</div>
		</div>
	);
});

// Shades a row behind its bars: grey where it has no data (outside the loaded rows, e.g. before a
// capped layer's oldest record or before it loads, or not read from the source yet), hatched where
// the source's data is likely incomplete. HTML rather than SVG, since a hatch pattern would stretch
// with the bars' viewBox. The bars' SVG only takes the pointer on its bars, so these titles show
// on hover elsewhere.
function Shading({ shading, first, count }: { shading: RowShading; first: number; count: number }) {
	const place = ({ start, end }: TimeWindow) => ({
		left: `${((start - first) / (count * HOUR)) * 100}%`,
		width: `${((end - start) / (count * HOUR)) * 100}%`,
	});
	return (
		<>
			{[
				...shading.notLoaded.map((range) => ({ range, title: "Not loaded" })),
				...shading.unread.map((range) => ({ range, title: "Not read from the source yet" })),
			].map(({ range, title }) => (
				<div
					key={`${title}-${range.start}`}
					title={title}
					className="absolute inset-y-0"
					style={{ ...place(range), backgroundColor: NOT_LOADED_COLOR }}
				/>
			))}
			{shading.likelyIncomplete.map((range) => (
				<div
					key={`incomplete-${range.start}`}
					title={INCOMPLETE_TITLES[range.reason]}
					className="absolute inset-y-0"
					style={{ ...place(range), backgroundImage: INCOMPLETE_HATCH }}
				/>
			))}
		</>
	);
}

type HourBarsProps = { counts: number[]; first: number; shading: RowShading; color: string; noun: string };

// Each row scales to its own busiest hour: the sources' counts differ by orders of magnitude.
// Memoized: the bars only change with the data, not with the handle.
const HourBars = memo(function HourBars({ counts, first, shading, color, noun }: HourBarsProps) {
	const max = Math.max(1, ...counts);
	return (
		<div className="relative h-6 md:h-8">
			<Shading shading={shading} first={first} count={counts.length} />
			<svg
				className="pointer-events-none relative block h-full w-full"
				viewBox={`0 0 ${counts.length} 1`}
				preserveAspectRatio="none"
			>
				{counts.map(
					(value, index) =>
						value > 0 && (
							<rect
								key={index}
								className="pointer-events-auto"
								x={index + 0.1}
								width={0.8}
								y={1 - value / max}
								height={value / max}
								fill={color}
							>
								<title>{`${formatSeconds(first + index * HOUR)}: ${value.toLocaleString()} ${noun}`}</title>
							</rect>
						),
				)}
			</svg>
		</div>
	);
});

type DayBandsProps = { days: DayCount[]; first: number; count: number; shading: RowShading };

// One band per date, spanning the date, since these records have no hour to sit in.
const DayBands = memo(function DayBands({ days, first, count, shading }: DayBandsProps) {
	const max = Math.max(1, ...days.map((day) => day.count));
	return (
		<div className="relative h-3">
			<Shading shading={shading} first={first} count={count} />
			<svg className="pointer-events-none relative block h-full w-full" viewBox={`0 0 ${count} 1`} preserveAspectRatio="none">
				{days.map((day) => {
					const x = Math.max((day.start - first) / HOUR, 0);
					const width = Math.min((day.end - first) / HOUR, count) - x;
					return (
						<rect
							key={day.start}
							className="pointer-events-auto"
							x={x + 0.25}
							width={Math.max(width - 0.5, 0)}
							y={1 - day.count / max}
							height={day.count / max}
							fill={OBSERVATION_COLOR}
							opacity={0.45}
						>
							<title>
								{`${dayFormat.format(day.start * 1000)}: ${day.count.toLocaleString()} recorded observations with a date but no time`}
							</title>
						</rect>
					);
				})}
			</svg>
		</div>
	);
});
