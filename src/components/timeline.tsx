"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import { DETECTION_COLOR, OBSERVATION_COLOR } from "@/components/map-colors";
import type { TimeWindow } from "@/lib/map-layers";
import {
	CALIFORNIA_TIME_ZONE,
	type DayCount,
	HOUR,
	hourAxis,
	localMidnights,
	spanToHour,
	TRAILING_HOURS,
} from "@/lib/timeline";

const timeFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: CALIFORNIA_TIME_ZONE,
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
});
const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: CALIFORNIA_TIME_ZONE, month: "short", day: "numeric" });
const formatTime = (epochSeconds: number) => timeFormat.format(epochSeconds * 1000);

type TimelineProps = {
	window: TimeWindow;
	// The start of the handle's hour (epoch seconds), or null for the whole window.
	hour: number | null;
	onHourChange: (hour: number | null) => void;
	// Per hour of the window's axis (hourAxis).
	observations: number[];
	detections: number[];
	dateOnly: DayCount[];
};

// Along the bottom edge, under the panel; the right side stays free for the chat.
export function Timeline({ window, hour, onHourChange, observations, detections, dateOnly }: TimelineProps) {
	const { first, count } = hourAxis(window);
	const last = first + (count - 1) * HOUR;
	const plotRef = useRef<HTMLDivElement>(null);

	// Pointer events can fire several times per frame. Only the latest position per frame reaches
	// the map, and an unchanged hour doesn't re-render at all, so MapLibre gets at most one
	// setFilter per layer per frame.
	const frame = useRef(0);
	const pending = useRef<number | null>(null);
	const scheduleHour = (next: number | null) => {
		pending.current = next;
		if (frame.current) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			onHourChange(pending.current);
		});
	};
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	const hourAt = (clientX: number) => {
		const rect = plotRef.current!.getBoundingClientRect();
		const index = Math.floor(((clientX - rect.left) / rect.width) * count);
		return first + Math.min(Math.max(index, 0), count - 1) * HOUR;
	};
	const onPointer = (event: PointerEvent<HTMLDivElement>) => {
		if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
		else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		scheduleHour(hourAt(event.clientX));
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const current = hour ?? last;
		const next = {
			ArrowLeft: Math.max(current - HOUR, first),
			ArrowRight: Math.min(current + HOUR, last),
			Home: first,
			End: last,
		}[event.key];
		if (next !== undefined) {
			event.preventDefault();
			onHourChange(next);
		} else if (event.key === "Escape") onHourChange(null);
	};

	// Positions on the axis, as percentages of its width.
	const at = (time: number) => ((time - first) / (count * HOUR)) * 100;
	const span = hour === null ? null : spanToHour(hour, TRAILING_HOURS, window);

	return (
		<div className="absolute right-3 bottom-3 left-3 space-y-2 rounded-lg bg-white/95 p-3 text-xs text-zinc-700 shadow-md">
			<div className="flex items-center gap-3">
				<button
					type="button"
					aria-pressed={hour === null}
					onClick={() => onHourChange(null)}
					className={`rounded border border-zinc-200 px-2 py-1 ${
						hour === null ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
					}`}
				>
					Whole window
				</button>
				{span && hour !== null ? (
					<p>
						Showing {formatTime(span.start)} – {formatTime(span.end)}: up to {TRAILING_HOURS} hours to the handle,
						older records fainter. Modeled conditions for the hour from {formatTime(hour)}.
					</p>
				) : (
					<p>Showing the whole window. Drag along the timeline, or use the arrow keys, to step through it by the hour.</p>
				)}
			</div>

			<div className="flex gap-2">
				<div className="w-44 shrink-0 space-y-1 text-zinc-600">
					<p className="flex h-8 items-center">Recorded observations / hour</p>
					<p className="flex h-3 items-center text-[11px]">Date only, no time recorded / day</p>
					<p className="flex h-8 items-center">Satellite thermal detections / hour</p>
				</div>

				<div className="flex-1">
					<div
						ref={plotRef}
						role="slider"
						tabIndex={0}
						aria-label="Timeline hour"
						aria-valuemin={first}
						aria-valuemax={last}
						aria-valuenow={hour ?? last}
						aria-valuetext={hour === null ? "Whole window" : formatTime(hour)}
						onPointerDown={onPointer}
						onPointerMove={onPointer}
						onKeyDown={onKeyDown}
						className="relative cursor-ew-resize touch-none space-y-1 select-none focus-visible:outline-2 focus-visible:outline-zinc-900"
					>
						<HourBars counts={observations} first={first} color={OBSERVATION_COLOR} noun="recorded observations" />
						<DayBands days={dateOnly} first={first} count={count} />
						<HourBars counts={detections} first={first} color={DETECTION_COLOR} noun="satellite thermal detections" />

						<div className="pointer-events-none absolute inset-0">
							{localMidnights(window).map((midnight) => (
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
						{localMidnights(window).map((midnight) => (
							<span key={midnight} className="absolute pl-1" style={{ left: `${at(midnight)}%` }}>
								{dayFormat.format(midnight * 1000)}
							</span>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

// Each row scales to its own busiest hour: the sources' counts differ by orders of magnitude.
function HourBars({ counts, first, color, noun }: { counts: number[]; first: number; color: string; noun: string }) {
	const max = Math.max(1, ...counts);
	return (
		<svg className="block h-8 w-full" viewBox={`0 0 ${counts.length} 1`} preserveAspectRatio="none">
			{counts.map(
				(value, index) =>
					value > 0 && (
						<rect key={index} x={index + 0.1} width={0.8} y={1 - value / max} height={value / max} fill={color}>
							<title>{`${formatTime(first + index * HOUR)}: ${value.toLocaleString()} ${noun}`}</title>
						</rect>
					),
			)}
		</svg>
	);
}

// One band per date, spanning the date, since these records have no hour to sit in.
function DayBands({ days, first, count }: { days: DayCount[]; first: number; count: number }) {
	const max = Math.max(1, ...days.map((day) => day.count));
	return (
		<svg className="block h-3 w-full" viewBox={`0 0 ${count} 1`} preserveAspectRatio="none">
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
}
