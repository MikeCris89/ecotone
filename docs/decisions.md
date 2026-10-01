# Decision Log

How I interpreted the challenge, what I considered, and why I landed on the current scope. The full product spec lives in [project-brief.md](./project-brief.md).

I made these decisions working with Claude Code. Entries marked "Suggested by Claude; I agreed" started as its proposals. I reviewed every entry and can explain the tradeoffs behind each.

---

## 1. Where the agent adds value

**Decision:** The map and timeline handle selection. The agent handles analysis.

A user shouldn't have to type "show me California in August 2020" when a map and a slider do that better. Natural language earns its place when a question requires combining, comparing, or interpreting data across sources: "What changed in recorded observations after the fire?", "What was recorded closest to thermal activity?", "Does the evidence actually support that?"

## 2. The question and data sources

**Decision:** _How do recorded wildlife observations and environmental conditions vary around wildfire activity in California, right now and historically?_

**Sources:** NASA FIRMS (thermal activity) + iNaturalist (wildlife observations) + Open-Meteo (weather context). Each contributes something the others can't: an event, a biological signal, and continuous environmental context.

**Considered and cut:**

| Option                                   | Why it's not in the MVP                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| USGS Earthquakes                         | Good API, but it doesn't strengthen the wildlife question enough to justify another integration                  |
| Movebank                                 | Real animal tracks, but coverage is study-specific. I couldn't find a public dataset overlapping a usable fire   |
| eBird                                    | Strong effort data, but adds an integration and skews the wildlife view heavily toward birds                     |
| GBIF                                     | Excellent historical archive (used to validate the idea), but it lags days behind and isn't a real-time feed     |
| Montreal mobility (BIXI + STM + weather) | Dense live data and a city I know, but weaker domain fit, heavier ingestion, and no backfill for station history |

## 3. Scope: bounded, not global

**Decision:** One region (California) and one historical case study, instead of a worldwide explorer.

A global globe was technically possible, but the hard part wouldn't be the globe. It would be guaranteeing useful overlapping data everywhere a reviewer might click. A small dataset explored properly beats a large interface full of empty results.

## 4. Why CZU Lightning Complex 2020

I tested three California fires (Woolsey, CZU, Camp) for overlapping, usable data. CZU was clearly strongest. Its research-grade iNaturalist subset (counted via GBIF) has **1,349 observations before, 612 during, and 912 after (578 species)** across birds, insects, mammals, reptiles, and more, plus a strong FIRMS signal and complete hourly weather. Camp had excellent fire data but sparse, geographically lopsided wildlife records.

## 5. Real-time first, history second

**Decision:** Two modes on the same system. **Live California** is the default view; **CZU 2020** is the historical deep dive.

An early version was mostly a historical explorer with a live button bolted on. The brief emphasizes real-time repeatedly, so live became the default and first-class view. CZU is loaded through the backfill path of the same pipeline (shared schema, normalization, and agent tools), so it isn't a separate app.

## 6. Why store data at all

The database isn't a mirror of NASA or iNaturalist. It exists to:

- normalize three unrelated providers into one queryable model
- run fast cross-source spatial and temporal queries
- keep provenance and a record of what the app actually saw
- replay the timeline without hitting upstream APIs on every scrub
- make agent answers reproducible against the stored data (records keep their latest upstream state, not a version history, so an answer can change if upstream re-identifies a record)

I only persist the regions and time windows the app supports.

## 7. Scientific honesty

iNaturalist records measure human observation activity as much as wildlife. During CZU, observations dropped from ~45/day to ~16/day, but evacuations, closures, and fewer observers explain that as well as anything about animals.

So the app says **"recorded observations,"** never "population." FIRMS points are **"satellite thermal detections,"** not fire boundaries. Weather is **"modeled conditions."** The agent refuses or qualifies claims about population decline, displacement, or causation. I treat this as a feature: a reliable agent should know when the evidence can't support a conclusion.

## 8. Agent design

- **No RAG.** The data is coordinates, timestamps, counts, and species. Those are exact queries, and vector similarity doesn't help.
- **No LLM-generated SQL.** The model picks from a small set of deterministic, typed tools. The tools do the computation.
- **Evidence travels with results.** Every tool returns results, evidence, coverage, and limitations together.
- **Guardrails in code, not just the prompt.** For example, species-level trend comparisons are refused below a minimum count, rather than trusting the LLM to be careful.

## 9. Technology

| Choice                              | Why                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostGIS** (new to me)             | The first candidate that solved a core problem rather than just being new. Proximity queries like "observations within 25 km of detections in this window" are central to the app |
| Next.js + TypeScript                | UI, ingestion, cron jobs, DB access, and LLM calls in one deployable repo                                                                                                         |
| Supabase Postgres                   | Hosted Postgres with PostGIS, no extra infrastructure                                                                                                                             |
| Raw parameterized SQL (postgres.js) | PostGIS functions stay readable. Injection is prevented by parameterization plus a closed set of tool queries. Prisma's PostGIS support would have meant raw queries anyway       |
| Vercel                              | Hosting and scheduled ingestion in one place                                                                                                                                      |

Also considered: React Native, Three.js, and RAG as the "new technology." Each was new, but none solved a real problem here. I also deliberately avoided Redis, a separate worker platform, and other infrastructure without a demonstrated need.

## 10. Map library

**Decision:** MapLibre GL via react-map-gl.

**Considered:** deck.gl on top of MapLibre, Leaflet.

WebGL rendering keeps thousands of points smooth while the timeline scrubs, and MapLibre is open source with no access token. **Tradeoff:** heavier than Leaflet. deck.gl can be added later if a layer needs it.

**Pinned to maplibre-gl v5 (Phase 6b):** v6 loads its web worker from a separate file next to the library, found through `import.meta.url`. Turbopack's browser runtime replaces `import.meta.url` with a placeholder `file://` URL, so the map fails with "Worker failed to load", and the worker copy Turbopack emits can't import its shared chunk. v5 inlines the worker and needs no setup. **Upgrade path:** copy `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` from `node_modules` into `public/` at build time and call `setWorkerUrl()`.

## 11. LLM provider

**Decision:** Anthropic Claude via the Vercel AI SDK.

**Considered:** the Anthropic SDK directly (hand-written tool loop), OpenAI via the AI SDK.

The AI SDK gives Zod-typed tools, a bounded multi-step tool loop, and streaming to React, and the provider can be swapped. **Tradeoff:** an extra abstraction layer with version churn.

## 12. Local development database

**Decision:** Supabase CLI + Docker.

**Considered:** developing directly against the hosted project.

`supabase/migrations` is the single schema history, applied the same way locally and to the hosted project, and resets are free. **Tradeoff:** requires Docker, and the local stack runs services the app doesn't use (auth, storage).

## 13. iNaturalist ingestion

**Decision:** Ingest all quality grades (research, needs ID, casual) in both modes, and apply the default display/analysis filter at query time. Poll every 5 minutes. Don't store raw upstream payloads.

**Considered:** ingesting research-only, or research + needs ID. Storing raw payloads alongside normalized rows.

Live polling asks for records changed since the last poll. If casual were filtered out upstream, a record later downgraded to casual (e.g. marked captive) would simply stop appearing, leaving a stale "needs ID" row. Storing every grade keeps rows truthful, and the display default stays a query-time choice that can be identical in Live and CZU. The real API (September 2026, California animals, last 7 days) was about 57% research, 41% needs ID and 2% casual, with needs ID outnumbering research in the most recent 24 hours. At ~55 changed records per 5 minutes, one request per poll suffices. Normalized columns plus `source_url` cover provenance without raw payloads. **Tradeoff:** ~2% extra rows, and every query must apply the grade filter.

## 14. FIRMS live ingestion

**Decision:** Poll VIIRS near-real-time data from all three satellites (S-NPP, NOAA-20, NOAA-21) every 15 minutes, re-fetching yesterday and today (UTC) each time. Store only NRT detections, at every confidence level, with one ingestion run per satellite per poll.

**Considered:** S-NPP only (matches the CZU product); adding MODIS; storing the provisional ultra-real-time (URT) detections that FIRMS publishes within minutes for the US.

Each satellite passes over California about twice a day, so three satellites give ~6 passes instead of 2, which is what makes the live timeline worth scrubbing. MODIS has 1 km pixels and a different confidence scale. FIRMS deletes URT detections once their NRT version arrives (1 to 3 hours later) and nothing links the two, so storing URT would leave stale duplicates unless every poll deleted rows missing from the latest response. With only a few passes a day, the extra latency costs little. FIRMS has no detection IDs or "changed since" query, so the key is built from satellite, time and coordinates, and each poll is a full snapshot rather than a cursor. **Tradeoffs:** live detections lag passes by hours; Live and CZU counts differ in satellite coverage unless filtered to S-NPP; NRT has no fire-type flag, so live detections can include industrial heat sources.

**URT check (2026-09-29, 21:29 UTC):** that day's California Area API responses included URT rows (VIIRS_SNPP_NRT 45, NOAA-20 30, NOAA-21 37), so storing them is possible. Live ingestion stays NRT-only for now; see roadmap "Later".

## 15. Open-Meteo live ingestion

**Decision:** Sample modeled conditions at a fixed ~0.5° grid of 169 points inside California, from NOAA's HRRR model (pinned), hourly values only. Poll hourly (at :20), re-fetching the last 24 hours, and never store forecast hours.

**Considered:** ~30 hand-labelled places; points that follow thermal-detection clusters; fetching weather when a user clicks; Open-Meteo's default `best_match` model; 15-minute "current" values; polling every 30 minutes.

A fixed grid gives every point an unbroken series and keeps anywhere in California, except near the coast, within ~35 km of a sample point, whether or not anything is burning. Points that follow detections would come and go, and fetching on click would make agent answers unreproducible. `best_match` blends models per variable without saying which, so the stored model would be a guess; HRRR's 3 km cells suit California's terrain. Hourly values match ERA5 for CZU and the timeline's buckets, so polling faster buys nothing. Re-fetching 24 hours fills gaps from up to a day of missed polls at no extra cost, since Open-Meteo counts up to two weeks for one point as one call. **Tradeoffs:** a value describes one model cell near the queried place, not the place itself, and the cell Open-Meteo picks can be ~5 km from the requested point; no soil moisture in Live (HRRR doesn't provide it); Live (HRRR, 3 km) and CZU (ERA5, ~25 km) aren't the same basis; "current" conditions can be up to an hour old.

**Terms and limits:** the free tier is non-commercial. That's fine for this demo, but a commercial deployment would need a paid plan (Professional for historical data). The free limits are 10,000 calls/day and 300,000/month, and each point counts as a call, so polling uses ~4,060/day (169 × 24, about 41% of the daily limit; ~122,000/month). Limits apply per IP and Vercel functions share outgoing IPs, so a 429 can come from other tenants' traffic; the poll is then recorded as failed or partial and stored data stays. The data is CC BY 4.0, which requires visible Open-Meteo attribution in the UI.

## 16. Source licensing and attribution

**Decision:** A `data_sources` table holds each provider's license and required attribution text. `ingestion_runs.source` references it, so every record reaches its license through its ingestion run. iNaturalist's source license is null, because each observation stores its observer's own license.

**Considered:** license columns on every record; license columns on `datasets`; documenting weather and FIRMS as exceptions to the brief's per-record provenance.

Per-record columns would repeat one constant on thousands of rows. A dataset (e.g. Live California) mixes all three sources, and FIRMS rows don't link to a dataset at all, so `datasets` can't hold a source's license. The ingestion run is the one link every record already has. Licenses: FIRMS is NASA-mission data, CC0 unless marked otherwise, with NASA's requested acknowledgement sentence; Open-Meteo is CC BY 4.0 with a "Weather data by Open-Meteo.com" link wherever its data is shown. **Tradeoff:** a record's license takes a two-table join, and the agent's evidence must include it explicitly.

## 17. Seeding the live window

**Decision:** Manual `POST` routes, protected by `CRON_SECRET` and run against the deployment, one iNaturalist date per call.

**Considered:** a local CLI script (needs `tsx` and the production database URL on a laptop); having the first live poll seed the window itself (iNaturalist already had a live cursor, and it would blur live and backfill runs).

**Tradeoff:** Vercel's function time limit forces per-date calls, and seeding is a manual step.

## 18. Map loading and default filters

**Decision:** The map loads each layer's whole Live window (California, 7 days) once, as compact rows capped per layer, and narrows it to 24h / 3 days / 7 days on the client. TanStack Query refreshes each layer on its source's poll cadence. The API routes still accept a bbox and window. Vercel's CDN caches each layer for about a third of its source's poll interval (iNaturalist 2 minutes, FIRMS 5, weather 20), then serves it stale for as long again while it refetches. Rows carry only what the client styles or filters by (location, time span, animal group, positional accuracy, obscured flag, quality grade as an index); a record's details are fetched on click. Default filters, shared by the map and the agent tools: iNaturalist research + needs ID, FIRMS nominal + high confidence. A record with only an observation date counts in every window its Los Angeles calendar date overlaps. Basemap: OpenFreeMap, with the style URL in an environment variable.

**Considered:** refetching the viewport on every pan; GeoJSON responses; no CDN caching; plain `fetch`; research-only observations; including low-confidence detections; placing date-only records at midnight.

The Live window is bounded (~32,000 recorded observations a week, ~2 MB as compact rows), so one load makes switching windows and scrubbing the timeline instant, where per-pan refetches would re-download nearly the same data at statewide zoom. Per-layer caps (50,000 observations, 30,000 detections, 50,000 weather readings) keep each response under Vercel's 4.5 MB limit, and a capped layer reports its full count. At its cap the iNaturalist layer is already ~3.7 MB, so any new row field needs a lower cap. Research + needs ID is iNaturalist's "verifiable" set; research-only would thin the newest live data, which is mostly needs ID. Low confidence is ~4% of live detections. A midnight time would invent precision, while the whole date keeps the record in every window it could belong to. GeoJSON would repeat every property name on every row, so rows are tuples and the client builds GeoJSON once per response. Layers only change when a poll lands, so the CDN can answer repeat requests without touching the database, and a few extra minutes are small next to each source's own latency (FIRMS ~3 hours after a pass, hourly model output, iNaturalist upload lag of hours to days). OpenFreeMap needs no key but has no SLA, so switching to e.g. Carto is a configuration change. **Tradeoffs:** the one-load approach only works while the window stays this size; much more data would need the bbox parameters or server-side aggregation. CZU counts under this filter won't match the GBIF research-only figures in the brief. The agent tools must state the defaults in their limitations, or their numbers won't match the map. A cached layer can be behind the database by up to twice its fresh time (4 minutes for iNaturalist, 10 for FIRMS, 40 for weather), so the client measures windows from the response's `end` rather than the browser clock.

## 19. Timeline

**Decision:** The timeline steps through the selected window by the hour. The map shows the 24 hours up to the handle, older records fading to half opacity. A step's trailing day can reach back before the selected window into the loaded 7 days, so only the 7 days window starts its steps a day in. Weather shows one hour, falling back to a point's latest reading up to 3 hours earlier, drawn stale and labelled with its age. The hourly bars are counted in the browser from the loaded rows and drawn as plain SVG, with no charting library; hours a layer hasn't loaded, or its source hasn't read (20), are shaded, not drawn as zero. Recorded observations with a date but no time are counted once per date in their own band, never in the hourly bars. Every time in the app is California time, labelled PT. Playback steps 4 hours per second at 1× and 16 at 4×, and stops at the end.

**Considered:** showing only the handle's hour; clipping the trailing day to the selected window (early steps showed a few hours, and FIRMS none at all between passes); leaving weather blank when its hour isn't stored yet; pre-aggregated bucket tables in the database (brief 5.2); Recharts or another charting library; the browser's timezone.

Showing a single hour makes the map flicker. Most hours have no satellite pass, so thermal detections would blink on for one step, and date-only records would seem to happen at whatever hour the handle is on. A trailing day keeps detections visible between passes, as fire maps do. Weather's newest hour usually isn't stored yet (the poll runs at :20), so a blank layer at the newest hour would look broken; a faded, dated reading shows the gap instead of hiding it. One clock means a time on the timeline matches the same time in a popup, wherever the viewer is. Counting the loaded rows takes a few milliseconds, needs no new table or endpoint, and the bars can't disagree with the map. About 170 bars don't need a library, and a custom drag handle is simpler without one. **Tradeoffs:** counting in the browser only works while the whole window is loaded (18); CZU's longer range may need database buckets (Phase 14). A date-only record stays on the map for up to 47 steps: its date, plus the trailing day after it.

## 20. Coverage and freshness

**Decision:** A source's coverage is the union of its successful runs' read ranges, on observation (or acquisition) time. Partial runs count as likely incomplete, and an hour stays settling until what can still arrive for it has been read: iNaturalist uploads for the 48 hours after it (by a backfill run then, or by the live cursor), FIRMS publications for 6 hours (3 hours of NRT latency plus 3 of publishing). So live data's newest hours settle, while history backfilled long after has no settling band. (Phase 9 review: the band first sat at the newest read hours, which would have flagged the last 48 hours of any backfilled history. Suggested by Claude; I agreed.) iNaturalist's update-time cursor counts as observation-time coverage, because a record is uploaded after it's observed. Each source gets one statement that keeps how far it has been read apart from how settled that is, e.g. "Read through Sep 29, 8:10 PM PT. Before Sep 27, 8:10 PM PT: mostly complete, late uploads still possible. Last 48 h: likely incomplete while uploads arrive." The map and the agent quote it rather than any bare `covered_until`.

**Considered:** the latest run's `covered_until` only; a settling band sized from measured upload delays; a reason code column on `ingestion_runs`.

The latest run alone hides outages in the middle of the window, and would show a backfill date's superseded partial attempts as gaps. Measured upload delays would be more precise, but the fixed bands match what seeding showed (Phase 5) and need no extra query. Partial-run reasons are read from the error messages the ingestion code writes, which needs no migration. **Tradeoffs:** the band widths are estimates, not guarantees. A reworded error message falls back to "stopped by an error". iNaturalist records rejected by validation can't be placed in time, so they're stated as a count of rejections (one record re-read by overlapping polls counts again) rather than marked on the timeline.

## 21. Agent before CZU

**Decision:** With one day left, build the agent first (tools, chat, evals), then weather on the map and the README. CZU becomes a stretch goal, loaded for the agent only if time allows.

**Considered:** CZU first as planned, with a thinner agent; the agent fetching missing history on demand instead of CZU.

The production agent is the one evaluated requirement still missing, and natural-language questions are what the challenge is built around. On-demand fetching needs everything CZU needs plus coverage by area, abuse limits (the URL is public) and a map that can show other windows, so it's my answer to "how would this evolve", not a one-day build. **Tradeoff:** "historical" rests on the stored live window (a week and growing) until CZU lands. The tools are ready for it (22).

## 22. Agent tools take an area and a time range

**Decision:** Every tool is a plain function over a bbox and a time range. What data exists comes from the stored ingestion runs whose bbox contains the area, not from the live window. A separate 31-day cap only protects query speed. Suggested by Claude; I agreed.

**Considered:** tools tied to the live window, or to a dataset or mode.

Tied to Live, CZU and fetched history would each need their own tools. Reading coverage from runs means any backfilled area and range can be answered as soon as it's stored. **Tradeoff:** coverage is by bbox containment, so a run over all of California covers any area inside it, even where a source has no sample points (between weather grid points). The weather tool states its distance to the nearest point instead.

## 23. Report coverage gaps instead of refusing

**Decision:** Tools compute over the hours actually read and say so ("Read 192 of 197 hours"). Rates count only records in read hours, per read hour. Tools answer `insufficient` only below 80% read, and a comparison is refused when its periods' read shares differ by more than 10 points. The first plan refused on any gap; reviewing it with Claude's help, I changed it to this.

**Considered:** refusing on any gap; answering over the whole range with a warning.

Live ingestion always has small gaps (a failed poll, an API hiccup), so refusing on any gap would make the agent refuse constantly, which reads as broken rather than careful. Answering over the whole range would divide by hours nobody read. The two numbers are judgment calls: 80% is roughly where a total stops representing its range, and past 10 points apart, uneven reading can skew a comparison even per hour, since the gaps may fall on the busy hours. I'd tune both with real outage data. **Tradeoff:** an hour read only partly counts as read, so a partial run can still flatter a range's coverage; the statement names those stretches.

## 24. Evidence for aggregate answers

**Decision:** A count's evidence is the exact query (area, range, filters, coverage) plus up to 10 sample records picked deterministically (newest; closest for proximity), each with its ID, source link, license and times. Suggested by Claude; I agreed.

**Considered:** returning every matching record; random samples.

Every record would swamp the model: a California-wide 3-day summary matches ~12,000. A handful of records can't prove a total, but the query reproduces it, and the IDs let the map highlight the samples. Random samples would make the evals flaky. **Tradeoff:** the model sees examples, not the full set, so the UI must offer the full set through the query.

## 25. Observations near thermal detections

**Decision:** The proximity tool counts recorded observations before and after nearby satellite thermal detections separately (within 25 km and 72 hours at most), with the unique total alongside, and states how many it excluded: imprecise (over 1 km), unknown accuracy, or date only.

**Considered:** one "within H hours" count; silently dropping imprecise records.

An observation a day before a detection and one a day after mean different things, so the direction is explicit. One observation can fall on both sides of different detections, so the two counts must never be added. Dropping imprecise records silently would hide how much of the data the answer rests on. **Tradeoff:** answers are longer, and the model has to be told never to add before and after.

## 26. Thermal detection clusters in metres

**Decision:** Detections are clustered with `ST_ClusterDBSCAN` in California Albers (EPSG:3310), 2 km apart by default.

**Considered:** clustering in degrees.

A degree of longitude shrinks northward (about 93 km at the Mexican border, 83 km at the Oregon border), so a distance in degrees means something different across the state. EPSG:3310 is in metres and made for California, CZU included. **Tradeoffs:** clustering is spatial only, so one cluster can span several days; DBSCAN chains nearby detections, so one big fire becomes one cluster; and the projection only suits California.

## 27. Weather from the nearest sample point

**Decision:** The conditions tool reads the nearest sample point with readings and states its distance, refusing past 50 km to the grid cell.

**Considered:** interpolating between nearby sample points.

Interpolation would invent values the model never produced, while the nearest point's values are real model output with a known distance. **Tradeoff:** a point up to ~35 km away (farther on the coast) describes a different place, so the distance is part of every answer.

## 28. Chat rate limits in Postgres

**Decision:** Chat rate limits and per-request usage live in one Postgres table, checked in a transaction before each message.

**Considered:** in-memory counters; Vercel Firewall rate limiting; Upstash Redis.

Serverless instances don't share memory, so in-memory counters reset between calls and can't cap a day's spend. Redis would be new infrastructure for a few hundred rows a day. The table doubles as the usage log (tokens, steps, duration), which shows what a message really costs before I tune the limits. A per-IP limit alone doesn't cap spend when IPs rotate, so each bucket also has a daily cap. **Tradeoff:** a database round trip before every message, and a table that grows by one row per message.

## 29. The chat sees the map's context

**Decision:** Each question carries the map's context: the view clipped to California's box, the selected window, the timeline handle, and the `end` the map's data runs to. The server turns it into explicit areas and ranges with the map's own window functions, checks the client's `end` (not in the future, at most 2 hours old), and hands them to the model as ISO times. Earlier questions keep the context they were asked with, written into the history by the server from the numbers the client stored.

**Considered:** the server clock for ranges; the view as is; only the newest question's context.

The map's data comes through a CDN cache up to 40 minutes old, so the server clock disagrees with what's on screen; anchoring on the map's `end` makes "this week" in chat exactly the map's 7 days, and the model never does date arithmetic. The statewide view reaches past California, where no ingestion run covers, so the tools would refuse the default zoom. Without each question's own context, the model read earlier answers against the new view and called correct ones wrong after the map moved (seen twice in browser testing). **Tradeoff:** a longer prompt per turn, and a client-sent `end` that has to be checked.

## 30. Reviewer access through a link

**Decision:** Reviewers open the demo with `?key=…`. The server checks the key and sets a cookie holding its hash, which puts them in a separate rate-limit bucket from the public.

**Considered:** a code typed into a form; real auth (a brief non-goal); one shared bucket.

Public traffic could use up a shared bucket before reviewers arrive. A link is the least friction for a reviewer, and a cookie keeps them in their bucket without the key in later URLs. The panel only shows "Reviewer access" once the server has confirmed it. **Tradeoff:** the key sits in the address bar (history, screenshots, logs); it only raises a limit, and rotating it invalidates every cookie.

## 31. Evidence comes from tool results

**Decision:** The records an answer rests on are taken from the tool results of that turn, never from the model's text. The model cites records as `[source:id]`, and a citation is only kept if a tool returned that ID. Suggested by Claude; I agreed.

**Considered:** trusting the IDs the model writes.

A model can invent or garble an ID, and a highlighted record that no query returned would be a fabricated source. **Tradeoff:** a record the model mentions in words but doesn't cite isn't highlighted.

## 32. Chat history without tool results

**Decision:** Earlier turns are sent as the question and the final answer text only, for the last two turns. The panel sends only its last 10 messages.

**Considered:** the full history, tool calls and results included; no history.

Tool results are most of a turn's tokens, so a full history's cost grows with every question, and useChat's whole history eventually passed the route's message cap. Without history, follow-ups ("what about there?") break. **Tradeoff:** a follow-up can't reuse an earlier turn's numbers; the model calls the tool again.

## 33. Proximity reported per detection cluster

**Decision:** The proximity tool reports the largest detection clusters first, each with its recorded observations and closest pair, and counts the observations near only the smaller clusters separately. When the largest clusters have none nearby, the answer explains the zero and offers a 10 km / 48 h search.

**Considered:** the closest pairs statewide; dropping weak detections by default; reporting a zero bare; offering the 25 km / 72 h maximum.

The closest pairs statewide were mostly weak night-time detections near towns (likely static heat sources), while the largest cluster never appeared. Dropping weak detections also drops small real fires. A bare zero reads as "no wildlife near fires", when large fires burn where few people record. The maximum search takes in almost every detection. **Tradeoff:** the headline zero depends on the default radius and window, so the answer has to say which it used.

## 34. Our own answer renderer

**Decision:** The panel parses answers itself (paragraphs, lists, headings, bold, italic, `[source:id]` citations) into React elements, never HTML.

**Considered:** `react-markdown`; showing raw text.

Model output is untrusted, so it never becomes HTML. Owning the parser makes citations easy to turn into evidence links: `react-markdown` would need a plugin or a text-node override. Raw text showed asterisks. **Tradeoff:** it only reads what the model writes today; a new syntax shows as plain text until it's added.

## 35. Chat usage logged once per question

**Decision:** Each finished step's token usage is collected in memory and written once, when the reply ends, is cut off, or fails.

**Considered:** writing only when a reply finishes; writing after every step.

Writing only on finish missed requests the client left or the model failed, so the log undercounted spend. Writing after every step survives a hard stop at the 120 s limit, but costs up to 8 writes per question. The Anthropic console stays the source of truth for spend; the log is for per-question analysis. **Tradeoff:** a request killed at the time limit logs nothing.

## 36. Weather answers from the readings it has

**Decision:** The conditions tool doesn't refuse a range for missing hours. It answers from the hours with readings and says how many ("54 of 72 hours", counting the hour marks in the range) and how old the newest is. By-day answers give each day's hours read, its hours in the range and its hours in the day, and mark a day partial only when readings are missing from its hours in the range; a partial day gets no precipitation total. A day cut by the range's start or end (a 7-day window's first day, or today) isn't partial, so the answer doesn't call data missing when it isn't. When a range that reaches the present has no readings yet (a question before the hour's poll lands), it falls back to the nearest point's latest reading and states its age: within the map's own 3-hour lookback that counts as current; older, it's the last available reading and the feed is said to be behind. A past range with no readings is still refused.

**Considered:** the 80% rule the counting tools use (23); refusing "right now" before the poll lands; always treating the latest reading as current.

A single reading isn't skewed by missing hours the way a count is, so refusing threw away good answers, and "what are conditions right now?" failed for part of every hour. The summaries are skewed, though: a day read only at night understates its high temperature and overstates its lowest humidity, and the driest or gustiest hour, or the prevailing wind, can be missing. So instead of refusing, the answer says which hours it rests on. Calling any latest reading current would present a stale feed as live, and sharing the map's lookback keeps the map and the agent from disagreeing about what "current" means. **Tradeoffs:** a summary over few hours can still read as more than it is if the model drops the caveat; an answer can describe conditions up to 3 hours old as current, with the age stated.

## 37. Evidence markers from the evidence's own coordinates

**Decision:** An answer's evidence is drawn on the map in its own layer, from the coordinates each evidence record carries, as a filled dot inside a ring. It ignores the timeline, the window and the layer toggles; a "Clear highlights" control (and New chat) removes it. Weather evidence opens a small card for the cited reading, not the weather layer's popup.

**Considered:** highlighting the map's own points by ID; a ring alone; reusing the weather popup.

Highlighting by ID breaks whenever the timeline or window filters a point out, and needs ID conversions (the map uses numbers for iNaturalist and weather). A ring alone around a point the timeline hides looks like an empty circle. The weather popup shows the timeline's hour, so it would show a reading the answer never cited. **Tradeoff:** evidence can show at a time the timeline isn't on, so it has to look distinct from the layers, and it needs its own control to clear.

## 38. Unmatched citations are counted, not hidden

**Decision:** A `[source:id]` citation that no tool in the turn returned is stripped from the answer's text, and a small line under the answer says how many ("1 citation couldn't be matched to a tool result"). The count is logged per request in `chat_requests`.

**Considered:** dropping them silently; showing them as raw text.

Dropping them silently makes an answer look better grounded than the model actually was, which undercuts the point of citing. Raw IDs are noise and could look like real sources. The logged count is also a free measure for the evals (Phase 11). **Tradeoff:** a slightly busier answer when the model garbles an ID.

## 39. Weather layer: wind by default, one colour at a time

**Decision:** The weather layer is on when the map opens and shows wind alone: streaks pointing where the wind blows, bigger and with more streaks when it's stronger. Gusts, humidity and temperature are a "Colour points by" choice, one at a time, off by default. Suggested by Claude; I agreed.

**Considered:** colouring the arrows by gusts (the original plan); letting several variables colour the points at once; keeping the layer off by default with temperature as its view.

Wind is the condition most tied to how fire behaves, and arrows read at a glance without a legend. One dark arrow colour stays readable over the basemap and over any fill, and two colours on one dot can't both be read. **Tradeoff:** gusts only show when picked, and a third layer on by default adds clutter next to the recorded observations and detections.

## 40. Open decisions

- Charting library for the agent's metrics (the timeline uses plain SVG, 19)
