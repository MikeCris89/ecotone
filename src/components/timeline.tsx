"use client";

import { type KeyboardEvent, memo, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { DETECTION_COLOR, OBSERVATION_COLOR } from "@/components/map-colors";
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

// Drawn over the parts of a row with no loaded data, so they don't read as zero activity.
const NOT_LOADED_COLOR = "#e4e4e7";

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
};

// Along the bottom edge, under the panel; the right side stays free for the chat. Memoized, since
// the map re-renders on every mouse move over it.
export const Timeline = memo(function Timeline(props: TimelineProps) {
	const { window, hour, span, onHourChange, observations, detections, dateOnly } = props;
	const { first, count } = hourAxis(window);
	const last = lastHour(window);
	const midnights = useMemo(() => localMidnights(window), [window]);
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
		<div className="pointer-events-auto w-full shrink-0 space-y-2 rounded-lg bg-white/95 p-3 text-xs text-zinc-700 shadow-md">
			<div className="flex items-center gap-3">
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
				{span && hour !== null ? (
					<p>
						Showing {formatSeconds(span.start)} – {formatSeconds(span.end)}: the {TRAILING_HOURS} hours to the handle,
						older records fainter. Modeled conditions for the hour from {formatSeconds(hour)}, or the latest reading
						up to {WEATHER_MAX_AGE_HOURS} h earlier, faded.
					</p>
				) : (
					<p>
						Showing the whole window, with modeled conditions for its newest hour. Drag along the timeline, use the
						arrow keys, or press play to step through it by the hour.
					</p>
				)}
			</div>

			<div className="flex gap-2">
				<div className="w-44 shrink-0 space-y-1 text-zinc-600">
					<p className="flex h-8 items-center">Recorded observations / hour</p>
					<p className="flex h-3 items-center text-[11px]">Date only, no time recorded / day</p>
					<p className="flex h-8 items-center">Satellite thermal detections / hour</p>
					<p className="flex h-4 items-center gap-1 text-[11px] text-zinc-500">
						Scaled per row;
						<span className="inline-block size-2.5" style={{ backgroundColor: NOT_LOADED_COLOR }} /> not loaded
					</p>
				</div>

				<div className="min-w-0 flex-1">
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
							loaded={props.observationsLoaded}
							color={OBSERVATION_COLOR}
							noun="recorded observations"
						/>
						<DayBands days={dateOnly} first={first} count={count} loaded={props.observationsLoaded} />
						<HourBars
							counts={detections}
							first={first}
							loaded={props.detectionsLoaded}
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

// Shades the axis outside `loaded`: before a capped layer's oldest loaded record, after a layer's
// data ends (layers refresh on different cadences), or the whole row before the layer loads.
function NotLoaded({ loaded, first, count }: { loaded: TimeWindow | null; first: number; count: number }) {
	const ranges: [number, number][] = loaded
		? [
				[0, (loaded.start - first) / HOUR],
				[(loaded.end - first) / HOUR, count],
			]
		: [[0, count]];
	return ranges.map(
		([from, to]) =>
			to > from && (
				<rect key={from} x={from} width={to - from} y={0} height={1} fill={NOT_LOADED_COLOR}>
					<title>Not loaded</title>
				</rect>
			),
	);
}

type HourBarsProps = { counts: number[]; first: number; loaded: TimeWindow | null; color: string; noun: string };

// Each row scales to its own busiest hour: the sources' counts differ by orders of magnitude.
// Memoized: the bars only change with the data, not with the handle.
const HourBars = memo(function HourBars({ counts, first, loaded, color, noun }: HourBarsProps) {
	const max = Math.max(1, ...counts);
	return (
		<svg className="block h-8 w-full" viewBox={`0 0 ${counts.length} 1`} preserveAspectRatio="none">
			<NotLoaded loaded={loaded} first={first} count={counts.length} />
			{counts.map(
				(value, index) =>
					value > 0 && (
						<rect key={index} x={index + 0.1} width={0.8} y={1 - value / max} height={value / max} fill={color}>
							<title>{`${formatSeconds(first + index * HOUR)}: ${value.toLocaleString()} ${noun}`}</title>
						</rect>
					),
			)}
		</svg>
	);
});

type DayBandsProps = { days: DayCount[]; first: number; count: number; loaded: TimeWindow | null };

// One band per date, spanning the date, since these records have no hour to sit in.
const DayBands = memo(function DayBands({ days, first, count, loaded }: DayBandsProps) {
	const max = Math.max(1, ...days.map((day) => day.count));
	return (
		<svg className="block h-3 w-full" viewBox={`0 0 ${count} 1`} preserveAspectRatio="none">
			<NotLoaded loaded={loaded} first={first} count={count} />
			{days.map((day) => {
				const x = Math.max((day.start - first) / HOUR, 0);
				const width = Math.min((day.end - first) / HOUR, count) - x;
				return (
					<rect
						key={day.start}
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
	);
});
