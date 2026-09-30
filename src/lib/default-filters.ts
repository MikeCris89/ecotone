import type { FirmsDetectionRow } from "@/lib/firms/normalize";
import type { InatObservationRow } from "@/lib/inaturalist/normalize";

// Query-time defaults for everything the app displays or analyses: the map layers now, the agent
// tools later, so an answer's counts match what the map shows. Every value is stored; these only
// decide what's shown by default. See decisions.md, 18.

// iNaturalist's "verifiable" set. Casual records are mostly captive or cultivated organisms, or
// lack a photo, date, or location good enough to verify.
export const DEFAULT_QUALITY_GRADES: InatObservationRow["quality_grade"][] = ["research", "needs_id"];

// A recorded observation counts as precisely located when its positional accuracy is known and at
// most this many metres, and its location isn't obscured (the brief's ≤1 km rule). Unknown
// accuracy is never precise.
export const PRECISE_ACCURACY_M = 1_000;

// Low-confidence VIIRS detections (~4% of live ones) are mostly weak anomalies or sun glint.
export const DEFAULT_FIRMS_CONFIDENCE: FirmsDetectionRow["confidence"][] = ["nominal", "high"];
