# Roadmap

## Phase 0: Scaffold

- [x] Next.js + TS + Tailwind, Supabase project with PostGIS, postgres.js client, env setup
- [x] Deploy hello-world to Vercel

## Phase 1: Schema v1

- [x] Migrations: datasets/presets, ingestion_runs, iNaturalist observations (geography + indexes)

## Phase 2: iNaturalist live ingestion

- [x] Adapter, Zod validation, normalization, idempotent upsert, ingestion run record
  - A successful poll by updated time doesn't prove complete coverage by observation date; coverage logic must keep `time_field` separate
- [x] Cron route polling California; verify rows accumulate in production
  - Verified in production: 134 consecutive `succeeded` runs over 11 hours (2026-09-29), no missed polls

## Phase 3: FIRMS live ingestion

- [x] Table, adapter (Area API), cron
  - Verified against the real API's CSV locally. Migration pushed and `FIRMS_MAP_KEY` set in production. Confirmed in production (2026-09-29): three `succeeded` runs, one per satellite, every 15 min

## Phase 4: Open-Meteo live ingestion

- [x] Decide sampling strategy, table, adapter, cron
  - Verified against the real API locally: one poll stored 169 points × 25 hours in under a second. Both migrations (weather, `data_sources`) pushed to production. Confirmed in production (2026-09-29): one `succeeded` run per hour at :20

## Phase 5: Seed live window

- [x] Backfill last 7 days for all three sources
  - Verified against the real APIs locally (2026-09-29): all 15 runs succeeded. Open-Meteo 30,589 readings (169 points × 181 hours) in one run; FIRMS 3,218 detections in 6 runs; iNaturalist 31,526 records over 8 dates, at most 32 pages per date. Re-running Open-Meteo and iNaturalist 2026-09-22 inserted nothing and updated every record. Ran against production after merge (2026-09-29): every run succeeded except iNaturalist 2026-09-24, whose first two runs (263, 282) ended `partial` with "fetch failed" mid-pagination, after 18 and 7 pages. A third run re-paged the whole date and succeeded, with upserts completing it at 4,031 records, in line with neighbouring dates. The iNaturalist client now retries network errors (#7)

## Phase 6: Map (Live)

- [x] 6a: Map layer API routes (#10)
  - `GET /api/map/{inaturalist,firms,weather}?window=24h|3d|7d`, optionally with all of `west,south,east,north`. They return compact tuple rows (`InatMapRow`, `FirmsMapRow`, `WeatherMapRow` and `WeatherMapPoint`, documented in each source's `map.ts`), the default filters applied (from `src/lib/default-filters.ts`), the full match count `total`, `truncated`, and the window's `start` and `end`. See decisions.md, 18
  - Verified locally (2026-09-29) with tests and curl: 24h iNaturalist window exactly 24 hours, 7-day iNaturalist layer 27,823 rows at 2.0 MB, bad bbox or window returns 400
- [x] 6b: Map with the three layers, window selector, attribution
  - Full-screen map with a top-left panel (the bottom edge stays free for the timeline, the right side for chat). Each layer loads its whole 7-day window once through TanStack Query, refetching every 5 min (iNaturalist), 15 min (FIRMS) and 60 min (weather). No `placeholderData`: the query key never changes, so refetches, and failed ones, keep the previous data anyway
  - The 24h / 3 days / 7 days selector only swaps MapLibre filters, measured from each response's `end`. Each window rule exists in TypeScript (for counts) and as a filter expression; tests run both through MapLibre's own evaluator (`src/lib/map-layers.ts`)
  - iNaturalist: "recorded observation density" heatmap fading into circles at zoom 7–9. Precise (known accuracy ≤1 km, `PRECISE_ACCURACY_M` in `src/lib/default-filters.ts`) is filled, imprecise or obscured is large and faint, unknown accuracy is a ring
  - FIRMS: circles from 3 px statewide to 6 px at zoom 10 (footprint-sized circles were tried and looked too big up close; revisit in a UI pass). Weather: off by default; each point's latest hour at its model grid cell, blue (cold) to purple (warm), with a °C scale
  - Each `/api/map/*` response carries its source's attribution and license from `data_sources`, so `/` stays static. The legend shows counts in the window, empty states, failed refreshes, and a capped layer's cutoff ("the oldest N records, from … and earlier, aren't loaded")
  - maplibre-gl is pinned to v5: v6's worker doesn't load under Turbopack (decisions.md, 10)
  - Verified locally (2026-09-29): tests, then in the browser with `pnpm dev` and `pnpm build && pnpm start`: `/` is static, all layers render, toggles work, and switching windows makes no requests. To confirm after merge: the production map shows live data with attribution
- [x] 6c: Click details (#12)
  - `GET /api/map/inaturalist/[id]` and `/api/map/firms/[id]` return one record's details for a popup with its source link (`InatMapDetails`, `FirmsMapDetails` in each source's `map.ts`). Weather popups use the loaded layer: the point's latest reading, the model, and the distance from the sample point to the grid cell the values describe. Popups live in `src/components/map-popup.tsx`
  - Detail lookups ignore the default filters (a record that changed since the layer loaded comes back as stored). `WeatherMapPoint` gained `gridDistanceM` (PostGIS `st_distance` on geography, the rule the agent tools will share) and `retrievedAt`. Popups show observed, uploaded and retrieved times separately, and only CC-licensed photos (iNaturalist's 75 px square). An all-rights-reserved photo is an empty box linking to the observation. Only the topmost record opens, with a "+N more records here" count. The selection is kept by ID, so a popup closes whenever its record leaves the map; an open popup refetches its details on its layer's cadence
  - CDN caching is now per source, fresh for about a third of the poll interval and stale for as long again (`LAYER_REFRESH_MINUTES` in `src/lib/map-layers.ts`, decisions.md, 18)
  - Verified locally (2026-09-29): tests (159 passing), typecheck, lint, and popups for all three layers in the browser. To confirm after merge: production popups open, and their source links work (including the FIRMS Fire Map link, a Phase 3 limitation)
  - Introduced/native status stays out of popups until it's verified (Phase 2 limitations)
  - The map-layers tests evaluate filters with `@maplibre/maplibre-gl-style-spec` (dev dependency, approved 2026-09-29), at 24.10.0, the version maplibre-gl 5.24.0 resolves. maplibre-gl's browser bundle compiles in its own copy (declared `^24.8.1`), so bump the two together

## Phase 7: Timeline

- [x] 7a: Hourly timeline and scrubbing
  - Decided (decisions.md, 19): the handle steps by the hour. The map shows the 24 hours up to the handle, older records fading to half opacity. Every layer loads 7 days whatever window is selected, so a step's trailing day can reach back before the selected window; only the 7 days window starts its steps a day in (`stepWindow`), and "Whole window" still shows all 7 days. Weather (map and popup) shows one hour: the handle's, or the newest when the whole window is shown. A point without that hour's reading shows its latest one up to 3 hours earlier, faded, with its age in the popup (`WEATHER_MAX_AGE_HOURS`); past that it's left out. Bars are counted on the client from the loaded rows and drawn as plain SVG, scaled per row, with the time a layer hasn't loaded (capped, not yet refreshed, or not loaded at all) shaded. Date-only recorded observations are counted once per date in their own band. Every time in the app is California time, labelled PT
  - The timeline spans the selected window, ending at the newest layer response's `end`. "Whole window" returns to the Phase 6 view for records. A refresh or a narrower window moves the handle to the timeline's nearest end instead of resetting it. A handle position reaches the map through at most one state update per animation frame, and only when the hour changes, so MapLibre gets at most one `setFilter` per layer per frame. Shown counts and the selected-record lookup are memoized per span, and the timeline doesn't re-render on map hovers (`src/lib/timeline.ts`, `src/components/timeline.tsx`)
  - The panel and timeline stack in one column, so the panel scrolls rather than hiding under a taller timeline; the basemap attribution moved to the top right
  - A popup closes when its record leaves the trailing span (the 6c rule). A weather popup for an earlier reading says its retrieval time isn't loaded: the layer only carries each point's newest reading's
  - Verified locally (2026-09-29): tests (181 passing), typecheck, lint. The first and last six steps' loaded rows, shown rows and fade ranges were replayed against the local database for the 7 days and 24h windows: every step shows a full 24 hours, and weather has all 169 points from the first step. Checked in the browser during review, including the FIRMS clusters. To confirm after merge: in production, scrubbing is smooth, the newest steps show faded weather rather than none, and times match between the timeline and popups
  - Side change (asked for during 7a review): zoomed out (below zoom 7), 10 or more satellite thermal detections within ~10 px draw as one ring, its radius growing with the square root of the count and capped at 20 px so it doesn't hide the recorded observations around it (tuned on local data, see `FIRMS_CLUSTER`), and clicking one zooms in until it splits (`FIRMS_CLUSTER` in `src/lib/map-layers.ts`). MapLibre clusters in the source, before layer filters, so the FIRMS source holds only the detections in the shown span instead of using a filter
- [x] 7b: Playback: play/pause and a 1× / 4× speed toggle (about 4 hours per second at 1×), stopping at the end
  - Play moves the handle through the same path as a drag, one hour per step: 4 steps a second at 1×, 16 at 4× (the 7 days window's 144 steps take 36 or 9 seconds). It starts from the handle, or from the first step when the whole window is shown or the handle is at the end, and stops on the last hour, leaving the handle there. Dragging, the arrow keys, Home/End, Esc and "Whole window" pause it; Space plays and pauses while the timeline has focus. A window switch or refresh keeps it playing on the new axis (`playbackStart`, `nextPlaybackHour` in `src/lib/timeline.ts`)
  - Each step waits for the previous one's render and for an animation frame, so a slow map delays playback instead of queueing steps, and a hidden tab halts it. A popup still closes when its record leaves the trailing span (the 6c rule), so one opened mid-playback closes within about 24 steps
  - Verified locally (2026-09-30): tests (187 passing), typecheck, lint, and in the browser during review, including smooth playback at 4× on the 7 days window. If a larger layer ever makes it stutter, the fallback is to advance only once the map is idle (MapLibre's `idle` event). To confirm after merge: playback is smooth in production

## Phase 8: Freshness and data quality UI

- [x] 8a: Coverage and feed health per source (`src/lib/freshness.ts`, `GET /api/freshness`)
  - Coverage is intervals on observation (or acquisition) time: the union of each source's `succeeded` runs' `[window_start, covered_until]`, so an outage shows as a gap and a re-run backfill date covers its superseded attempts. Partial or interrupted runs are "likely incomplete", never complete: over what they read, or their whole window when they have no `covered_until` (a backfill cut off partway, a weather poll that lost a batch). Failed runs stored nothing. FIRMS counts an hour complete only once all three satellites are, and names each satellite's end when they differ. iNaturalist's live polls count as one unbroken read from the first poll in the window to the cursor: a record is uploaded after it's observed, so everything observed in that stretch and uploaded by the cursor has been read. Records a live poll rejected are skipped for good (the cursor moves past them) and can't be placed in time, so the statement gives the number of rejections in the window, even after later polls succeed. That counts rejections, not records: the 2-minute overlap between polls can re-read and re-count one bad record, and runs don't record which records were rejected
  - Likely-incomplete bands at the newest read hours: 3 hours for FIRMS (`FIRMS_SETTLING_HOURS`, on top of `NRT_LATENCY_MS`), 48 hours for iNaturalist uploads (`UPLOAD_LAG_HOURS`). Weather has none
  - Feed health: the latest live poll's start, and "behind" once a whole poll is missed (two intervals). The latest poll that finished (or died) gets a statement; for FIRMS, the worst satellite's. A run still `running` after 15 minutes is interrupted (`INTERRUPTED_AFTER_MINUTES`); one younger may still be going and is skipped. How runs get stuck `running`, and the optional sweep for them: issue #9
  - A run's statement never shows `covered_until` without its `status` (`runStatement`):
    - `succeeded`: "complete through 2:00 PM PT" (a live iNaturalist poll: "all updates read through …", since it reads by updated time)
    - `partial`, `covered_until` set: "read through 2:00 PM PT; 12 records failed validation", or another reason with its count
    - `partial`, `covered_until` null: "incomplete, cut off partway"
    - `failed`: "failed, nothing stored from this run". Every source keeps that true: a run that stored anything before failing is `partial`
    - `running` for over 15 minutes: "interrupted, may be incomplete". The run died without recording an outcome, possibly after storing some pages
  - Each source gets one `statement` combining coverage, the latest poll and feed health (decisions.md, 20). How far a source has been read is kept apart from how settled it is, so no stretch is called both complete and incomplete: "Read through Sep 29, 9:40 AM PT. Last 3 h may still fill in as satellite passes are published. No live poll in this window." Weather has no settling band, so it says "Complete through". The panel shows it, and the Phase 9 data status tool returns it. Partial reasons are matched from the error messages the ingestion code writes, with their counts (`PARTIAL_REASONS`, e.g. "12 records failed validation"); anything else is "stopped by an error"
  - `formatTime` moved to `src/lib/timeline.ts` so server code formats times the same way (PT)
  - The route is CDN-cached for a minute, stale for one more
  - Verified locally (2026-09-30): tests (201 passing), typecheck, lint, and the local data's output read through by hand: every source is behind (nothing polls locally), FIRMS is complete to its backfill less 3 hours, iNaturalist's latest live poll was paused on a page where every record failed validation (nothing lost: the cursor stays put)
- [x] 8b: Show coverage (trimmed, 2026-09-30)
  - Timeline: the observation and detection rows shade hours their source hasn't read in the same grey as "not loaded" (tooltips say which), and likely-incomplete hours hatched amber, with the reason on hover. The shading is HTML behind the bars (an SVG hatch would stretch with the bars' viewBox), so bar tooltips still work (`rowShading` in `src/lib/coverage.ts`)
  - The panel fetches `/api/freshness` every minute. Each layer shows its `statement` and the last poll's time (left out when behind, since the statement already says how long). A time rather than "N min ago", which a cached response would understate; "behind" is judged when the server answered, up to ~3 minutes earlier. When the span shown reaches past what's been read (complete or not, as the timeline shades it), by more than two poll intervals: "Satellite thermal detections after 9:40 AM PT aren't published yet", or "Nothing read after …: live polling is behind" when it is. If the whole span is unread, that note replaces "No … in this window" (`layerCoverage`). Weather gets the statement only: its layer already falls back to earlier readings
  - The interval math moved to `src/lib/coverage.ts` (no database code), shared by the server's coverage and the timeline
  - `formatTime` is pinned to en-US, so server-written statements read like the times the browser formats
  - Verified locally (2026-09-30): tests (208 passing), typecheck, lint, and in the browser during review: shading, hatching, tooltips, panel statements and the "not read" note on the local data
  - To confirm after merge: `curl -s <production URL>/api/freshness | jq '.sources[].statement'`. Locally every feed is behind, so production is the first real test of the healthy path: expect no "No live poll" sentences, each "Last poll" time within the source's interval, FIRMS read through about 3 hours ago, and on the timeline, a grey stretch plus a hatched band at the FIRMS row's right edge and a 48-hour hatch on recorded observations

Reordered 2026-09-30 for the final day: the agent is the missing requirement, so it comes first and CZU becomes a stretch goal (Phase 14).

## Phase 9: Agent tools

- [x] 9a: Tool contract, input checks, coverage; data status, observation summary and period comparison tools (`src/lib/agent/`)
  - Coverage loads the runs whose bbox contains the requested area (`getRunsCovering`), from any dataset, and reuses `sourceFreshness`. Comparisons refuse when the periods' read shares differ by more than 10 points (`MAX_READ_FRACTION_DIFFERENCE`); percent changes need 5 recorded observations in both periods (`MIN_COMPARE_COUNT`)
  - Verified locally (2026-09-30): tests (222 passing), typecheck, lint, and each tool run once on the local data (California, 3 days: ~100 ms)
  - Review fixes: rates count only records in read hours and use unrounded read hours; ranges are at least 1 hour; live-poll rejections reach the coverage statement and make it incomplete. Settling bands now come from when hours were read (decisions.md, 20), so backfilled history has none
- [x] 9b: Thermal detection clusters, observations near detections, modeled conditions
  - `summarizeDetections`: `ST_ClusterDBSCAN` in EPSG:3310, 2 km by default, every detection in a cluster (minpoints 1); each cluster's centre, radius, peak and total FRP, first and last times and dates. Evidence: each largest cluster's strongest detection
  - `observationsNearDetections`: radius ≤ 25 km, ≤ 72 h either side; before and after counted separately (one observation can be both, so `observations.total` is the unique count and the two must never be added); records too imprecise, of unknown accuracy or date-only are counted as `excluded`; only observations inside the area count, and iNaturalist coverage is checked over the widened time window. Evidence: the closest pairs
  - `getConditions`: the nearest sample point with readings, refused past 50 km to its grid cell; hour by hour up to 48 readings, otherwise by day; prevailing wind speed-weighted. Evidence: the latest, driest and gustiest hours
  - Verified locally (2026-09-30): tests (238 passing; the weather poll test is still flaky, issue #9), typecheck, lint, and each tool on the local data: 958 detections in 98 clusters (the 10 largest listed, the rest totalled), proximity in 320 ms, conditions in 13 ms
- [x] Second review round (2026-09-30)
  - iNaturalist hours settle once uploads 48 hours past them have been read, by the live cursor rather than the latest poll's start; a backfill that ran after live polling began hands on to the cursor, so the seed's last 48 hours settle (`settledReads`)
  - `getRunsCovering` loads only the tools' sources, up to the range's end plus the settling lag, so an old range doesn't load every poll since. Rejections count only from live polls started between the range's start and 48 hours past its end
  - Clustering runs once, ties broken by source ID so ranks and evidence agree (150 → 75 ms). Missing precipitation hours are left out of totals, with the count of hours that had a value. `NRT_LATENCY_MS` moved to `firms/client.ts`
  - Verified locally: tests (243 passing), typecheck, lint, and the live statements and tools on the local data
  - To confirm after merge: the production panel's iNaturalist statement still ends in a 48-hour band at the cursor, with nothing flagged before it
- Tools are plain functions taking an area and a time range, not tied to the live window, so stored history (CZU, fetched on request) works without changes. What data exists comes from ingestion-run coverage; a separate maximum range length only protects query speed
- Coverage: rates are computed over the hours actually read, and each source reports "read N of M hours". `insufficient` only below 80% read; comparisons also refuse when the periods' coverage differs too much
- Evidence samples are picked deterministically (newest, or closest for proximity) and carry record IDs, so the map can highlight them and evals stay stable
- Weather tool results must include the distance from the queried location to the weather point used
- Evidence carries each record's license and attribution: the record's own for iNaturalist, otherwise its source's (record -> ingestion run -> `data_sources`)
- Coverage comes from ingestion runs through `sourceFreshness` (`src/lib/freshness.ts`), never a bare `covered_until` (decisions.md, 20)
- Recorded-observation counts track observer effort and upload lag (see Phase 5 limitations): tools must not present day-to-day differences as changes in wildlife, and must flag the most recent 1–2 days as undercounted
- Use the map's default filters (`src/lib/default-filters.ts`) and state them in `limitations`, so answers match what the map shows (decisions.md, 18)
- Proximity analyses count a recorded observation as precisely located by `PRECISE_ACCURACY_M` (≤1 km, `src/lib/default-filters.ts`), the rule the map styles by. The time direction (before, after, or both) is explicit
- Detection clusters use `ST_ClusterDBSCAN` in EPSG:3310 (metres). Spatial only, so one cluster can span several days: stated in `limitations`

## Phase 10: Chat and evidence on the map

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`) via the AI SDK (`ai` v7, `@ai-sdk/anthropic`, both installed; `@ai-sdk/react` approved 2026-09-30, added in 10b for `useChat`). The API key is set in Vercel and `.env.local`. Read the AI SDK docs in `node_modules/ai/docs/` before writing code: v7's API differs from older versions. Set a monthly spend limit in the Anthropic console (Mike).

10a was built in two review stops (10a-1 and 10a-2) and shipped as one PR (#17), so the paid endpoint never went public without its rate limits.

- [x] 10a-1: Chat API route (`POST /api/chat`), testable with curl
  - One AI SDK tool per Phase 9 function (six), with the Zod input schema it already validates and a description written for the model. Descriptions must say: `summarize_detections` lists the N largest of M clusters; `observations_near_detections` must never add before + after (use `observations.total`); counts are "recorded observations", detections "satellite thermal detections", weather "modeled conditions"
  - System prompt: the brief's answer rules (6.6), the terminology, refusing population, causation, displacement and absence claims, citing evidence, stating limitations briefly. When a tool refuses the area or answers `insufficient`, Claude explains that plainly instead of retrying with other arguments
  - UI context becomes explicit arguments. The client sends the map view's bbox, the selected window, the timeline hour (or "whole window"), and the `end` its timeline ends at (the newest layer response's `end`). The server computes every range with the functions the map filters its layers with (`windowBounds`, `spanToHour`): 24h, 3 days and 7 days back from that `end`, plus the handle's trailing day. A test checks they match `parseMapQuery`'s for the same `end`. It hands them to Claude as ISO times, so "this week" in chat is exactly the map's 7 days, and Claude never does date arithmetic. The client's `end` is used only if it isn't in the future and is within 2 hours of the server clock; otherwise the server clock. (The map routes' `end` is the server clock at request time, cached by the CDN for up to 40 minutes, so the server can't know it without the client saying.) Counts can still differ slightly from the map's: the database may have stored records since the map's copy was cached
  - "Here" is the map view clipped to the Live dataset's bbox (California's box). The statewide view reaches past it (Nevada, the ocean), and the tools refuse any area no ingestion run fully contains. A view entirely outside California: the context says so, and Claude explains the app only covers California
  - Evidence comes from tool results, never the model's text. The map highlights the evidence of the tools called in that turn. Claude cites records as `[source:id]`; `validCitations` keeps only IDs found in that turn's tool evidence and drops the rest (used by 10c)
  - History: earlier turns are sent as the user's question plus the final answer text; their tool calls and results are dropped, so follow-ups work and cost per turn stays flat. Only the last 3 turns, a user message at most 2,000 characters
  - Bounded: at most 8 steps (`stopWhen`), `maxDuration` 120 s on the route
  - Prompt caching on the system prompt and tool definitions (Anthropic cache control through the provider options). The per-request UI context goes after the cached part
  - Streams the reply, including each tool call and its result, so the UI can show steps and evidence
  - Tests (the model is mocked with `MockLanguageModelV4`, never called): tool wrappers pass validated input through and return the tool's result; ranges match `parseMapQuery`'s for the same `end`; a bad client `end` falls back; view clipping (partly and fully outside); history stripping; `validCitations`; long messages rejected
  - Review fixes: the last step keeps its tools and gets an instruction to answer (the Anthropic provider implements `toolChoice: "none"` by removing the tools, which the API rejects when the history has tool calls). Only the new question is validated; an earlier question is sent only if an answer followed it, so a rejected one in useChat's history doesn't fail every later request
  - After the first real runs (2026-09-30, local data): the proximity tool's statewide "closest pairs" were mostly weak night-time detections near towns, likely static heat sources, while the largest cluster (1,387 detections) never appeared. It now reports the `maxClusters` largest clusters (ranked exactly as `summarize_detections` ranks them, through the shared `clusteredDetections`), each with its counts and closest pair, and the observations near the rest. On the local data, the 5 largest clusters had no precise recorded observations within 5 km and 24 hours: all 1,204 were near smaller clusters. Both detection tools take an optional `minFrpMw` and state that weak detections near towns are often static sources
  - The model sees a trimmed copy of each tool result (`forModel`, through `toModelOutput`): the result, limitations, each source's coverage statement, and evidence as source, ID, label and time. Links, licenses, coordinates and coverage spans only go to the UI (about 40% smaller on the first runs' outputs)
  - Prompt: "Animalia" is "identified only as animals"; places are described by what the tools return, never named from the model's own knowledge
  - The zero near the largest clusters depends on the defaults (5 km, 24 h): on the local data the largest cluster had 25 precise recorded observations within 10 km and 48 h, 92 within 25 km (the closest 7 km away). At 25 km, 1,756 of 1,825 detections have observations nearby, so the prompt explains a zero (few people record in remote, closed or evacuated terrain) and offers 10 km and 48 h rather than the maximum. 72 h either side of a range starting at the window's start reaches before the stored data and is refused as under 80% read
  - Review fix: the dataset is looked up before admission, so a failed lookup doesn't use a quota slot
  - The local iNaturalist feed's pause ("all 3 records on the page failed validation") was checked: the same page validates now, and production was healthy (read through the current poll, no rejections)
- [x] 10a-2: Reviewer access, rate limits and usage log
  - Two separate buckets, so public traffic can't use up the reviewers' quota. Public: 5 per IP per hour, 30 a day in total. Reviewer: 60 per IP per hour, 300 a day. All four are env vars (`CHAT_PUBLIC_HOURLY_PER_IP`, `CHAT_PUBLIC_DAILY`, `CHAT_REVIEWER_HOURLY_PER_IP`, `CHAT_REVIEWER_DAILY`) with those defaults. Hourly is the last 60 minutes; daily resets at midnight PT
  - Reviewer key (`REVIEWER_ACCESS_KEY`): the chat client reads `?key=` from the page URL and sends it as a request header. The key stays in the URL, no redirect. The chat route accepts the header or a cookie. A valid header also sets the cookie (httpOnly, Secure, SameSite=Lax, 30 days) on the chat response, holding a hash of the key, so a later visit without `?key=` stays in the reviewer bucket. A key change plus redeploy invalidates old cookies (their hash no longer matches). A wrong key silently means the public bucket. Setting the cookie from the chat route rather than a `proxy.ts` on `/` keeps `/` static and adds no per-page-load code. The bucket used reaches the client in the stream's message metadata, for a "Reviewer access" label (10b)
  - Rate limits and usage are one table, `chat_requests` (a migration): time, bucket, hashed IP (HMAC with `IP_HASH_SECRET`: a plain hash of an IPv4 address can be reversed by trying all 4 billion), which limit it hit (if any), input, output and cached input tokens, steps, duration, and whether the reply ended without an answer (e.g. the model called a tool on its last step despite the instruction). No message content. Checking and recording happen in one transaction under a per-bucket advisory lock, so two simultaneous requests can't both take the last slot. Requests turned away by a limit are logged but don't count toward it. A served request counts from the start, even if the model call later fails (it may have cost money); its usage is filled in when the stream finishes
  - When a limit is hit: 429 with a friendly message the panel shows ("Daily demo limit reached. It resets at midnight PT." / "Hourly limit reached. Try again after Sep 30, 3:12 PM PT."), as `{ ok: false, error, bucket, limit, retryAt }`. The map and timeline don't depend on the chat route
  - Tests: the right key in the header sets the cookie; a wrong key doesn't and uses the public bucket; a cookie from a rotated key is rejected; reviewer and public counters are independent; hourly and daily limits each return their friendly 429; turned-away requests don't count; usage is written from the mocked model's token counts
  - Built as `src/lib/chat/access.ts` (bucket, cookie, IP hash) and `src/lib/chat/limits.ts` (`admitRequest`, `recordUsage`). Usage is written in `streamText`'s `onEnd`, which the SDK awaits before closing the stream, so the write finishes within the request. Cache reads and writes are logged separately (writes cost more than uncached input)
  - New env vars, in Vercel (production) and `.env.local`: `REVIEWER_ACCESS_KEY` (unset: no reviewer bucket), `IP_HASH_SECRET` (required: the route answers 500 without it), and optionally the four limits
  - Verified locally (2026-09-30): tests (289 passing, the limit tests against the local database), typecheck, lint, and the first three questions by curl against the real model (10a-1). Before merge (Mike, 2026-09-30): `chat_requests` pushed to production, env vars set in Vercel. Confirmed in production (Mike, 2026-09-30): `/?key=…` gave `"bucket":"reviewer"` in the start chunk. The fire question ("What wildlife was recorded near thermal activity this week?") made one tool call (`observations_near_detections`), took ~12 s and cost ~4 cents. It led with the largest cluster (1,601 detections, 7 recorded observations within 5 km / 24 h), explained the zeros near clusters 2 to 5, offered the 10 km / 48 h search, cited only returned IDs, and stated the unread hours. A freshness question called `get_data_status` (~5 s). Prompt caching works: the cached prefix is ~9k tokens, read once per step (first question: 8,989 written and 8,989 read; a second one 4 minutes later: 17,978 of 20,079 input tokens read from cache, none written)
  - `CHAT_PUBLIC_DAILY` is 15 in production (Mike): at ~4 cents a question, 30 a day for a month would nearly fill the $40 monthly spend limit on its own
  - `chat_requests.limited` stays nullable text, null meaning served: the partial indexes and `admitRequest` filter on `limited is null` (`where not limited` is a type error, not a silent skip)
- [x] 10b: Chat panel on the right (the side 6b left free)
  - Streaming answers, with each tool step shown while it runs ("Checking data coverage…", "Finding thermal detection clusters…"): the wait feels interactive and the grounding is visible
  - Suggested questions that only appear when the current window can answer them (brief 6.7), e.g. no "near thermal activity" question when there are no detections
  - Sends the UI context (and the reviewer key from the URL, if any) with each message. A small "Reviewer access" label when the reviewer bucket was used; rate-limit messages shown in the panel
  - A reply with no answer text (the model called a tool on its last step, or the stream failed) shows a fallback in the panel ("Couldn't finish this one. Try a narrower question."), never an empty bubble. Approved by Mike: the fallback plus the `no_answer` flag and a Phase 11 eval, so the rate is measured
  - Notes from 10a for building it:
    - Request body: useChat's `messages` plus `context: { view: { west, south, east, north }, window: "24h" | "3d" | "7d", hour: number | null, end: string | null }` (`chatContextSchema` in `src/lib/chat/context.ts`). `hour` is the handle's hour in epoch seconds (null for "Whole window"); `end` is the timeline's end, the newest layer response's `end`. Extra body fields go through the transport (`DefaultChatTransport` body or `prepareSendMessagesRequest`: check the v7 docs)
    - The reviewer key goes in the `x-reviewer-key` header. `REVIEWER_HEADER` lives in `src/lib/chat/access.ts`, which imports `node:crypto`: don't import it into the client (a type import of `ChatMetadata` is fine); move the constant to a client-safe module instead
    - The bucket arrives as message metadata on the start chunk (`ChatMetadata`, `message.metadata.bucket`)
    - Errors: 400 (invalid request, blank or over 2,000 characters), 429 (limits) and 500 all answer `{ ok: false, error }` with a message meant for the user. Check how v7's transport surfaces a non-2xx body in useChat's `error`
    - Claude streams reasoning parts (empty text plus a signature, seen in the first curl runs): don't render them. Answers can contain light markdown (bold, lists) despite the prompt asking for plain sentences
    - Tool parts are typed `tool-<name>` with `state` input-available / output-available / output-error; step labels map from the six tool names in `src/lib/chat/tools.ts`
    - `turnEvidence` and `validCitations` (`src/lib/chat/citations.ts`) have no server imports and are ready for 10c
    - Locally nothing polls, so answers say the feeds are behind; production is the real test
  - Built as `src/components/chat-panel.tsx` (memoized: the map re-renders on every pointer move) and `src/lib/chat/ui.ts` (step labels, suggestions, error messages, answer parsing), with `@ai-sdk/react` pinned to 4.0.121, the release that depends on exactly the installed `ai` (7.0.118): later ones would install a second copy. `REVIEWER_HEADER` moved to `src/lib/chat/context.ts`
  - The context is read when a question is sent: the view from the map's bounds (no re-render per pan), the selected window, the handle's hour, and the newest layer response's `end`. The reviewer key is read from `window.location.search` at send time (`useSearchParams` would need a Suspense boundary on the static `/`)
  - Suggestions show while the chat is empty, from what's loaded for the selected window (all of the loaded map, not the view; not the handle's day, since the questions name the window): species when there are recorded observations, thermal activity when there are also detections, conditions when weather readings are loaded, freshness always. The questions name the selected window. Until 10d, detections just across the border count too
  - Answers are parsed into paragraphs, bullet and numbered lists, bold and `[source:id]` citations (`parseAnswer`) and built as React elements, never HTML: model output is untrusted. Owning the parser makes 10c's citation links a small change. The system prompt now limits formatting to those; anything else shows as plain text. Citations show as small muted text until 10c
  - Errors: a non-2xx response reaches useChat as an `APICallError` holding the body, so the route's own message is shown (and a 429's bucket); anything else is "Something went wrong. Try again." When a request fails, its error replaces the no-answer fallback rather than both showing. Input is disabled while a reply streams (a second question would use a quota slot and interleave replies) and capped at 2,000 characters with a counter near the limit. The panel scrolls to the newest step as the reply streams
  - Review fixes: the client sends only the last 10 messages (useChat sends the whole history, tool results included: past the route's 200-message cap every request failed); `summarize_detections`' per-satellite counts now apply `minFrpMw`; the prompt gets California's four edges, not the whole dataset row; the model sees a date-only observation's `observedOn` beside a null `observedAt` instead of the date in `observedAt`
  - Verified (2026-09-30): tests (303 passing), typecheck, lint. Not seen in a browser by Claude (no dev server started): the layout, streaming steps, reviewer label and 429 message are Mike's to check
- [ ] 10c: Evidence on the map
  - Evidence from the turn's tool results highlighted on the map by ID (iNaturalist and FIRMS IDs match the map's; weather evidence carries the sample point's ID), clicking one flies to it and opens its popup and source link. Evidence outside the loaded window is listed with its link instead. Inline `[source:id]` citations become links only if `validCitations` keeps them
  - An answer's coverage and limitations shown compactly under it
- [ ] 10d: Clip "California" to the state outline (after 10c, before Phase 11)
  - The Live bbox takes in parts of Nevada, Oregon, Arizona and Baja California, so statewide answers include e.g. a cluster at 40.82, -114.26 in Nevada (3.2 MW max, cluster #4 in the production fire answer, 2026-09-30). Once 10c shows clusters on the map, reviewers will see it
  - Load California's outline as a polygon (public domain source, one migration) and add `ST_Intersects` to the shared tool queries alongside the bbox. Ingestion and coverage stay rectangle-based: coverage is what was read; the outline filters what's counted
- Decision log candidates awaiting Mike's approval:
  - Reviewer key through a link, kept in a cookie (alternatives: a code typed into a form; real auth, a brief non-goal; one shared bucket, which public traffic could use up)
  - Evidence taken from tool results, and citations checked against them (alternative: trusting IDs in the model's text, which it can invent or garble)
  - Earlier turns sent without their tool results (alternatives: the full history, whose cost grows every turn; no history, which breaks follow-ups)
  - Chat ranges anchored on the map's `end`, sent by the client and checked by the server (alternative: the server clock, which disagrees with a cached map by up to 40 minutes)
  - The map view clipped to California's box (alternative: passing the view as is, which the tools refuse at the default statewide zoom)
  - Proximity reported per detection cluster, largest first (alternatives: the closest pairs statewide, which surfaced static heat sources in towns; dropping weak detections by default, which also drops small real fires)
  - The model sees a trimmed tool result, the UI the full one (alternative: the same result for both, ~40% more input tokens per tool call)
  - A zero near the largest clusters is explained, and a 10 km / 48 h search offered (alternatives: reporting the zero bare, which reads as "no wildlife near fires"; offering the 25 km / 72 h maximum, which takes in almost every detection and can reach before the stored data)
  - `chat_requests.limited` as nullable text, null meaning served (alternatives: a boolean plus a separate column for which limit; a `'none'` value). One column records which limit fired, and the partial indexes are built around `limited is null`
  - Suggested questions only when the loaded window has the data (alternatives: a fixed list, which offers a thermal activity question with no detections; checking the current view, more accurate but needs map state per pan)
  - Tool steps shown live with plain-language labels (alternative: a spinner until the answer arrives, hiding the 5 to 12 s of tool calls and what the answer rests on)
  - Answers parsed by our own small renderer (alternatives: `react-markdown`, which needs a remark plugin or a text-node override to turn `[source:id]` into evidence links in 10c; raw text with visible asterisks). It builds React elements only, and the prompt limits formatting to what it handles

## Phase 11: Agent evals (right after Phase 10, not optional)

- [ ] 10–15 questions with expected behaviour (answers, refuses, flags stale data, picks the right tool), run by `pnpm eval` against the deployed model. Graded by code, not an LLM. Kept out of `pnpm test`: it calls the real API
  - Include a question hard enough to use all 8 steps, checking the reply still ends with text (the last-step instruction works), alongside the `chat_requests` no-answer flag in production
  - Include a fire question, checking the answer leads with the largest clusters rather than the closest pairs statewide
- [ ] Trim the tool schemas' ISO date patterns (~3k of the ~9k cached prefix, see "Known limitations from Phase 10")

## Phase 12: Weather on the map

- [ ] Modeled conditions at the detection's hour in thermal detection popups (nearest grid point, with distance)
- [ ] Wind arrows (default weather view), sized by speed, coloured by gusts
- [ ] Variable picker: wind, humidity, temperature

## Phase 13: README and submission

- [ ] README (including how the system would evolve: on-demand history fetching), decisions review, final deploy check
  - Include: one big fire becomes one detection cluster, since DBSCAN chains nearby detections (650 in one near Yosemite, Sep 2026); known issues, including the flaky weather poll test (issue #9)

## Phase 14 (stretch): CZU for the agent

- [ ] Backfill iNaturalist, FIRMS CSV import, Open-Meteo archive, so the agent can answer CZU questions. The mode switch and CZU timeline come later
- Why it matters more after the first agent runs (2026-09-30): the live window gives a fire's "during" with little or no "before" in the same place (the largest live cluster started on the window's first day), and few precise recorded observations close to it. CZU has 30 days before, 38 during and 30 after in one small, heavily recorded area, which is what `compare_periods` needs. It still can't show how wildlife responded: the drop from ~45 to ~16 recorded observations a day is as much evacuations and closures as anything else (brief 7). The README should pitch it as "how recording changed before, during and after", not as a wildlife response
- Cheapest slice if time allows: iNaturalist only. `backfillObservations` already takes any dataset; it needs a CZU `datasets` row (a migration) and the backfill route to accept it (today it only takes the live dataset's window), then one call per date (98 dates). That alone makes `summarize_observations` and `compare_periods` answer for CZU. FIRMS (CSV import) and weather (ERA5 archive) each need a new retrieval path

## Later

- (stretch ideas go here)
- On-demand history: the agent requests a bounded backfill for the current map view when coverage says data is missing, recorded as ingestion runs, shown once complete. Needs spatial coverage, abuse limits, and a map that can show windows other than Live
- A "dry and windy" highlight on the weather layer (our own stated thresholds, never "Red Flag")
- CZU mode switch and before/during/after periods on the timeline
- Prune live records that fall outside the retention window (polling only bounds what's fetched, not what's kept)
- Extra weather points near thermal-detection clusters, on top of the fixed grid
- Live soil moisture (needs a pinned model that provides it; HRRR doesn't)
- Derive the map's 7-day window from the dataset's `retention_days` instead of hardcoding 168 hours (the routes' default, and the loaded window in `src/components/live-map.tsx`)
- A weather details lookup (like iNaturalist's and FIRMS's) so a popup for an earlier reading shows that reading's own retrieval times, not "not loaded"
- Incremental map refreshes (e.g. a `since` parameter) instead of re-downloading each whole layer on every refetch (~2 MB of iNaturalist every 5 minutes per open tab)
- Fix the flaky weather poll test (issue #9)
- Record why records failed validation (the first failing record's ID and Zod issue paths) on the ingestion run, so a paused iNaturalist feed can be diagnosed from the run alone
- Filter persistent static heat sources out of the detection tools: the same pixel lighting up on most nights (industrial sites, flares). Today they're only stated in limitations and pushed down by ranking clusters by size
- Draw each precise recorded observation's accuracy radius at its ground size when zoomed in (the map rows already carry positional accuracy)
- Upgrade maplibre-gl to v6 once the worker loads under Turbopack, or by serving its worker files ourselves (decisions.md, 10)
- Stable source links for settled weather readings through Open-Meteo's Historical Forecast API, if its archived HRRR values match the stored ones. Not for the newest hours, which HRRR still revises (Phase 4 limitations), so it suits the timeline and agent evidence more than the latest-hour popup
- List every record under a click instead of only the topmost plus a count
- Protect the map routes from CDN bypass: any new query string (an arbitrary bbox, or a junk parameter) misses the cache and runs a full layer query. Rounding the bbox alone doesn't help, since unknown parameters also change the cache key; the fix is rate limiting (e.g. Vercel's firewall) or ignoring unknown parameters in the cache key

### Known limitations from Phase 2 (check later)

- **Stuck `running` runs:** a poll killed mid-flight (e.g. the database hangs while saving) leaves its run `running` forever. It doesn't block the next poll, which resumes from `max(covered_until)` with no lock, but Phase 8's feed health shows a run still `running` after 15 minutes as interrupted (`INTERRUPTED_AFTER_MINUTES`)
- **Deleted or re-scoped upstream records:** observations deleted on iNaturalist, or re-identified out of Animalia, never reach an updated-since poll, so their rows stay. The Phase 5 backfill doesn't reconcile them either: it upserts what it finds and never deletes. Reconciling would mean deleting stored rows for a date that a complete backfill run didn't return
- **Invalid records are skipped, not retried:** when only some records on a page fail validation, the cursor moves past them and the run is marked `partial`. Recovering them needs a fix plus a re-run of the iNaturalist backfill for the affected dates (live window only; older dates are outside it). (A page where *every* record fails pauses the feed instead)
- **Tie-scan gap:** when more than a full page of records shares one `updated_at` second, the poll steps through it by page number. If a tied record is updated again mid-scan, another tied record can be missed until it next changes
- **Very large ties stall:** a tie bigger than one run's 20-page cap (~3,800 records in the live window in one second) restarts from page 1 each run and never finishes. Fix would be storing the page number on the run
- **Introduced/native flags:** which place iNaturalist computes them for is unconfirmed; verify before the UI highlights introduced species
- **`records_updated` overstates changes:** the 2-minute cursor overlap re-fetches ~40 unchanged records per poll, counted as updated because `retrieved_at` is refreshed

### Known limitations from Phase 3 (check later)

- **FIRMS `records_updated` is re-fetches, not changes:** every poll re-reads two days, so each run reports every already-stored detection (~600 on a quiet day) as updated
- **URT detections aren't stored:** live detections appear with NRT latency (hours), not within minutes of a pass. The Area API does return URT rows for California (confirmed 2026-09-29). Open question before storing them: does a URT row's acquisition time and coordinates match its NRT replacement exactly? If not, the derived `source_id` changes, and superseded provisional rows would need deleting (snapshot reconciliation)
- **Detections withdrawn upstream stay:** if FIRMS drops or reprocesses an NRT detection within the window, the old row isn't removed (same shape as the iNaturalist deleted-records gap)
- **No fire-type flag in NRT:** live detections can be industrial or other static heat sources; the UI and agent must not call them fires
- **`source_url` deep-link format:** check a stored link actually opens the FIRMS map at the right date and place
- **FIRMS coverage margin is a typical latency, not a guarantee:** `covered_until` stops 3 hours before each poll, but a slow day can publish passes later than that
- **No staleness guard in the FIRMS upsert (before the CZU import):** unlike the iNaturalist upsert, the last write wins. If the standard-product (SP) import shares source IDs with live NRT rows, a later NRT poll could overwrite SP values such as `fire_type` with null. Decide which product wins before importing SP

### Known limitations from Phase 4 (check later)

- **A weather point is not the queried place:** values describe one ~3 km model cell, and the nearest sample point can be ~35 km away (farther near the coast, see below). Open-Meteo sometimes picks a neighbouring cell: up to 4.7 km from the requested point in the first local poll. The UI and agent must state the distance
- **Coastal gaps:** grid cells whose centre falls offshore of the simplified state outline aren't sampled, so coastal places rely on the nearest inland point
- **Recent hours get revised:** each poll re-fetches 24 hours, so values can change as newer HRRR runs arrive. They settle once they're older than a day. `first_retrieved_at` records when an hour first appeared
- **`records_updated` is re-fetches, not changes:** every poll reports ~4,000 already-stored readings as updated
- **Weather `source_url` links expire:** each is the single-point, single-hour API request for the reading, which only resolves while Open-Meteo still serves that hour from HRRR (at least 8 days, as tested). Older readings keep their values, but the link stops working
- **Per-point call counting is assumed:** Open-Meteo's docs don't say how multi-point requests count against limits. Budgeting assumes one call per point; watch for 429s once the poll runs in production
- **Shared outgoing IPs:** Vercel functions share IPs, and Open-Meteo limits by IP, so rate limiting can come from other tenants. A poll that gets rate-limited is `partial` or `failed`; the next hourly poll re-fetches the gap

### Known limitations from Phase 5 (check later)

- **iNaturalist backfill isn't resumable:** a date that hits the 4-minute budget is `partial`, and a re-run starts it over from the lowest ID. That only helps when the slowdown was transient. A California date needs ~30 pages against a budget of ~100, so it shouldn't happen at current volume
- **iNaturalist backfill windows are approximate:** each run's window is a Los Angeles date's span, but iNaturalist filters on `observed_on`, the date the observer recorded
- **Coverage can span several runs:** a FIRMS backfill splits each satellite's window into two runs. `max(covered_until)` across runs would report full coverage even when one of them failed, so Phase 8's coverage merges each successful run's range instead
- **Weather backfill depends on Open-Meteo's HRRR retention:** it asks for up to 191 past hours (all 192 were served with no gaps on 2026-09-29). If Open-Meteo keeps fewer, the oldest hours come back missing and the run is `partial`
- **Seeding is manual:** the backfill routes aren't scheduled; iNaturalist takes one call per date
- **Counts reflect observer effort, not wildlife abundance:** Saturday 2026-09-26 had 6,226 recorded observations and Sunday 4,863, against ~4,000–4,500 on each weekday. Day-to-day differences track when people go out. Flagged for Phase 9
- **The latest days are undercounted:** uploads lag observations, so the most recent 1–2 days are incomplete when seeded (Monday 2026-09-28 had 3,068, below every other weekday). The live poll's updated-since cursor adds late uploads as they arrive. Flagged for Phase 9

### Known limitations from Phase 7 (check later)

- **Unpublished hours look like no activity:** fixed in Phase 8b. Hours a source hasn't read are shaded grey on the timeline, and the panel says they aren't published yet
- **Weather grid cell assumed constant per point:** popups for earlier readings use the point's newest reading's grid cell, distance and elevation. True for every stored reading locally (checked 2026-09-29: none of 169 points changed cell), not enforced
- **The 7 days window steps through 6 days:** its first day has no full trailing day loaded, so the handle starts a day in. Loading 8 days would fix it, at ~14% more payload and a longer retention window

### Known limitations from Phase 8 (check later)

- **Partial-run reasons come from error text:** `PARTIAL_REASONS` matches the messages the ingestion code writes. A reworded message falls back to "stopped by an error". A reason code column on `ingestion_runs` would fix it, at the cost of a migration
- **Rejections, not rejected records:** the iNaturalist statement counts rejections across live polls, and one bad record re-read by the 2-minute overlap counts again. Runs don't record which records were rejected, so there's no distinct count
- **Settling bands are fixed estimates:** 3 hours for FIRMS and 48 hours for iNaturalist uploads, not measured from the data. A slower day can still add records before the band
- **Feed health is judged when the server answers:** `/api/freshness` is cached up to ~2 minutes and refetched every minute, so "behind" and "No live poll for …" can be ~3 minutes late. Small next to the 10/30/120-minute thresholds
- **Test runs left in the local database:** the flaky weather poll test (issue #9) can leave a `running` run with a 2001 window. Freshness ignores it (its window is outside the Live window), but it stays in `ingestion_runs`

### Known limitations from Phase 10 (check later)

- **An answer can end without text:** the last of 8 steps is only told to answer. Logged as `chat_requests.no_answer`; Phase 11 measures it
- **The reviewer key stays in the address bar:** by design (no redirect), so it shows in screenshots, browser history and Vercel's request logs. It only raises a rate limit, and rotating `REVIEWER_ACCESS_KEY` invalidates it and every cookie
- **Tool schemas carry long ISO date patterns:** `z.iso.datetime` adds a ~600-character regex to every range field (~3k tokens across the six tools). Prompt caching makes it cheap after the first message; trimming it means changing `rangeSchema` (Phase 9)
- **Chat counts can differ slightly from the map's:** same range, but the map's layer can be up to 40 minutes old (CDN) while the tools query the database now
- **"California" is a bounding box:** statewide answers include detections and observations just across the border (fix planned in 10d)

### Known limitations from Phase 6 (check later)

- **Basemap console warning:** MapLibre logs "Expected value to be of type number, but found null instead" from OpenFreeMap Positron's own filters: road shields compare `ref_length` and boundaries `admin_level` on tile features that lack them. Harmless (those features are dropped, as intended); left alone rather than patching a third-party style on every load
