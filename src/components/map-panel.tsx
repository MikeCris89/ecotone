"use client";

import { DETECTION_COLOR, OBSERVATION_COLOR, TEMPERATURE_STOPS } from "@/components/map-colors";
import { type MapWindow, WINDOW_HOURS } from "@/lib/map-layers";

export type LayerVisibility = { inaturalist: boolean; firms: boolean; weather: boolean };

const WINDOW_LABELS: Record<MapWindow, string> = { "24h": "24h", "3d": "3 days", "7d": "7 days" };

const LAYERS: { key: keyof LayerVisibility; label: string; swatch: string }[] = [
	{ key: "inaturalist", label: "Recorded observations", swatch: OBSERVATION_COLOR },
	{ key: "firms", label: "Satellite thermal detections", swatch: DETECTION_COLOR },
	{ key: "weather", label: "Modeled conditions", swatch: TEMPERATURE_STOPS[2][1] },
];

type MapPanelProps = {
	mapWindow: MapWindow;
	onWindowChange: (window: MapWindow) => void;
	visible: LayerVisibility;
	onVisibleChange: (visible: LayerVisibility) => void;
};

// Top-left, leaving the bottom edge for the timeline and the right side for the chat panel.
export function MapPanel({ mapWindow, onWindowChange, visible, onVisibleChange }: MapPanelProps) {
	return (
		<div className="absolute top-3 left-3 w-80 space-y-3 rounded-lg bg-white/95 p-3 text-sm text-zinc-900 shadow-md">
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

			<ul className="space-y-2">
				{LAYERS.map(({ key, label, swatch }) => (
					<li key={key}>
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={visible[key]}
								onChange={(event) => onVisibleChange({ ...visible, [key]: event.target.checked })}
							/>
							<span className="size-3 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
							<span className="font-medium">{label}</span>
						</label>
					</li>
				))}
			</ul>
		</div>
	);
}
