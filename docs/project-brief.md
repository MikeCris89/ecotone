# Project Brief: California Wildfire & Wildlife Explorer

This document describes what the app is, what it must do, and why. It is the source of truth for scope. It deliberately does not prescribe an implementation order. Sections marked **Open for discussion** are decisions that have not been made yet and should be raised with Mike before committing to an approach.

---

## 1. Context: the take-home challenge

This is a take-home engineering challenge for **Inversa** (inversa.com), a company that works with state wildlife agencies on invasive species management. Their platform (Origin) provides real-time field intelligence and applies habitat data and species trends to guide action. The project's domain (wildlife observations + environmental conditions) was chosen partly because it is adjacent to their work.

**Time budget:** roughly 65 hours from the start of the project to submission.

### The task (from the brief)

Build a natural-language-driven interface for exploring a question about the physical and natural world using three or more relevant real-time data feeds. Design the ingestion, storage, and query system behind it, then deliver a single interface for exploring questions in natural language, following evidence to its source, and replaying change over time.

### Technical requirements

- Three or more relevant **real-time** data feeds organized around a coherent shared question
- Backend infrastructure for **collecting, storing, and querying** those feeds
- A **web interface** supporting natural-language queries across real-time **and** historical data
- An **interactive timeline** for visualizing and replaying changes over time

### Deliverable requirements

- At least one meaningful part of the solution must use a technology that is **new to Mike** (chosen: **PostGIS**)
- The finished demo must be **deployed online** and accessible through a shared URL

### What they evaluate

- A well-designed system with clear boundaries, thoughtful data modeling, and sensible architectural decisions
- A well-designed production agent that interprets natural-language questions, uses the available data and tools effectively, and returns **reliable, grounded answers**
- A responsive, human-friendly interface that makes the data easy to explore and understand
- A fast experience: queries feel interactive and the **timeline scrubs smoothly**
- High-quality data handling: accurate real-time information and **clear treatment of stale, missing, or conflicting data**

### What they explicitly do not care about

- Authentication, user accounts, permissions, identity management (**do not build any of this**)
- Test-coverage percentages, strict style-guide compliance, procedural completeness

### Mike will be asked about

- The question chosen, why it matters, and why these data sources support it
- Major product and technical design choices, alternatives considered, and tradeoffs
- How the system would evolve for substantially more data, traffic, users, or use cases

Design decisions should be explainable. Prefer explicit, readable code over clever abstractions. When making a non-obvious tradeoff, leave a short comment or note so it can be discussed later.

---

## 2. The shared question

> **How do recorded wildlife observations and environmental conditions vary around wildfire activity in California, right now and historically?**

This wording is intentional. The app explores **evidence and relationships**. It does **not** claim to measure ecological effects. It never says "wildfires caused wildlife to decline." See section 7 for why.

---

## 3. The two modes

The app has two modes that run on **the same system**: same source adapters, same schema, same agent tools. A mode is essentially a preset of `(region, time window)`.

### 3.1 Live California (default view)

The app opens here. This mode is what satisfies the "real-time feeds" requirement, so it must feel first-class, not bolted on.

- **Region:** California (approximate bounding box: lat 32.5 to 42.0, lon -124.5 to -114.1; refine as needed)
- **Time window:** a fixed retention window (e.g. 7 days) with selectable sub-ranges (24h / 3 days / 7 days). The window is **seeded from upstream recent history** at setup, then kept current by scheduled polling. Seeded records keep their original observation times
- **Bounded loading:** the browser only loads data for the current viewport and time window, never the whole statewide dataset
- **Shows:** recent FIRMS thermal detections, recent iNaturalist wildlife observations, current and recent weather context
- **Freshness is visible:** each source shows when it was last successfully ingested and how old its newest record is
- Much of the time there may be little thermal activity. That is fine. Empty results are reported honestly, not hidden

The live mode's job is to demonstrate the full pipeline operating today: external APIs, scheduled ingestion, normalization, persistent storage, freshness metadata, querying, agent.

### 3.2 CZU Lightning Complex 2020 (historical case study)

The deep analytical showcase, one click away from Live. Data is loaded through a **backfill path that shares the same normalization, storage, and query contracts** as live ingestion, not a separate system.

- **Analysis region (bounding box):** west -122.40, south 36.96, east -122.03, north 37.33
  - This rectangle includes unburned surroundings. It is **not** the burn perimeter.
- **Periods (inclusive):**
  - Before: 2020-07-17 to 2020-08-15
  - During (fire active): 2020-08-16 to 2020-09-22
  - After: 2020-09-23 to 2020-10-22

**Verified data availability** (research-grade iNaturalist records via GBIF, Animalia, coordinates present, no geospatial issues):

| Period   | Observations | Distinct species | Obs/day |
| -------- | -----------: | ---------------: | ------: |
| Before   |        1,349 |              382 |    45.0 |
| During   |          612 |              236 |    16.1 |
| After    |          912 |              320 |    30.4 |
| Combined |        2,873 |              578 |     n/a |

- Animal groups are diverse (birds, insects, mammals, snakes/lizards, others) across all periods
- 230 of the 578 species appear only once in the whole window; only 28 species have ≥5 observations in both before and after
- Records with coordinate uncertainty ≤1 km: 980 before, 473 during, 607 after
- FIRMS: ~2,878 filtered VIIRS S-NPP detections during the active period, peaking at 1,327 on 2020-08-19; 96.6% fall inside the final perimeter
- Open-Meteo historical (ERA5) returned complete hourly data for tested points

These counts were verified through GBIF, not the iNaturalist API directly. Direct API counts, taxonomy, and quality filters may differ (GBIF receives research-grade observations under specific licenses). **Direct historical retrieval from iNaturalist still needs to be validated** before relying on these exact numbers. See the quality-grade decision in section 5.2.

---

## 4. Data sources

Exactly three providers for the MVP. Each supports both **live polling** and **historical backfill** for a given bbox and time range. Retrieval paths may differ per mode (e.g. FIRMS historical CSV vs live Area API), but they share normalization, storage, and query contracts.

### 4.1 NASA FIRMS (thermal activity)

- Satellite-detected thermal anomalies (VIIRS, MODIS). Fields include lat/lon, acquisition date and time (UTC, HHMM), satellite/instrument, confidence, brightness, fire radiative power (FRP), scan/track pixel size
- **Requires a free MAP_KEY.** Area API supports bbox queries; current docs specify 1 to 5 days per request; limit of 5,000 transactions per 10 minutes
- Typical global near-real-time latency is ~3 hours after observation. Observation latency differs from how often a satellite passes over a location
- **Historical (CZU):** use the VIIRS S-NPP standard (science) product for consistency. Annual US CSVs are publicly downloadable and were successfully tested, e.g. `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2020/viirs-snpp_2020_United_States.csv`. Filter to presumed vegetation fires with nominal/high confidence
- **Interpretation boundary (important):** a detection is **not** a named wildfire, a perimeter, an ignition time, or burned area. Multiple detections can belong to one fire; some are agricultural or industrial heat. Clouds and smoke affect detection. The UI must label these as **"satellite thermal detections"**, never "fire spread" or "fire boundary." Timeline playback shows observed satellite passes, not continuous fire progression
- Native radius filtering is not documented; fetch by bbox and do distance filtering in PostGIS
- Attribution required per NASA reuse guidance

### 4.2 iNaturalist (recorded wildlife observations)

- API: `api.inaturalist.org/v1/observations`. Supports bbox (`swlat`, `swlng`, `nelat`, `nelng`), date ranges (`d1`, `d2`), taxon filters (`taxon_id=1` for Animalia), quality grade, and establishment-status filters (verify the `introduced` / `native` params)
- Requested rate: stay under ~60 requests/minute; be a polite client (User-Agent, backoff on 429)
- Records include taxon (with iconic group), observed date/time, coordinates, positional accuracy (may be missing), quality grade, observation URL, photos, license
- **Two timestamps matter:** `observed_on` / `time_observed_at` (when the animal was seen) vs `created_at` (when it was uploaded). Uploads often lag by hours or days, so the most recent window always looks artificially sparse. This must be stored and surfaced
- **Live polling must catch late changes**, not just observations dated today: delayed uploads of older observations, and later identification or quality-grade changes on existing records. Poll by created/updated time (verify the API's parameters for this) and upsert, rather than only querying by observed date
- **Introduced species** should be identifiable where iNaturalist's establishment data supports it (introduced flag / establishment means) and can be highlighted in the UI. **Introduced does not mean invasive:** only use an "invasive" label if backed by an authoritative, geographically relevant designation. Introduced-status highlighting is a small feature with high relevance to Inversa
- Licenses vary per observation (CC0, CC BY, CC BY-NC, etc.); retain license and attribution

### 4.3 Open-Meteo (environmental / weather context)

- Forecast/current API (current conditions use 15-minute model data) and Historical API (ERA5 from 1940, ~25 km resolution; ~5-day delay)
- No API key for the free non-commercial tier. Published limits: 600 calls/min, 5,000/hour, 10,000/day. Attribution required
- Useful variables: temperature, relative humidity, precipitation, wind speed/direction, wind gusts, surface soil moisture
- **Values are modeled for a grid cell, not measured at a point.** The API returns the grid coordinates and elevation it actually used, which can differ from the requested point by kilometres. Store the requested point, returned point, model, units, and elevation
- For historical comparisons, pin a specific model (e.g. ERA5) so the series basis doesn't change
- For CZU: 2 or 3 labeled representative locations within the analysis region, hourly, across the full window

### 4.4 Explicitly out of scope as sources

GBIF, eBird, Movebank, USGS Earthquakes, OpenAQ. These may be mentioned as "how I would extend this," but they are not integrated in the MVP.

---

## 5. Ingestion and storage

### 5.1 Principles

- **Shared contracts per source:** retrieval can differ between live polling and historical backfill, but both produce the same normalized records and go through the same storage path, parameterized by bbox + time range
- **Scheduled live ingestion** runs on a timer (the project is on Vercel Pro, so per-minute Cron schedules are available; function duration limits still apply). Suggested cadences to evaluate: iNaturalist every few minutes, FIRMS every 15 to 30 minutes, weather every 15 to 60 minutes
- **Idempotent upserts** keyed on source + source record ID, so re-running ingestion never duplicates data
- **Every ingestion run is recorded**: source, parameters (bbox, time range, filters), started/finished time, records fetched/inserted/updated, status, error, and whether results were truncated or paginated fully
- **Partial retrieval must never look complete.** If a run hit a page cap or failed midway, coverage metadata says so and the agent/UI treat that window as incomplete
- Selective storage: persist only supported regions and windows plus provenance. The DB is not a mirror of upstream archives
- **Persisted live data is the application's system of record for replaying live mode over time.** Upstream providers do retain some history; the reason to store it is fast replay, cross-source spatial queries, reproducible agent answers, and a record of what the app actually saw
- **Records hold their latest known state, not a version history.** Upserts overwrite a record when upstream changes it (e.g. a new identification or quality grade), so an answer replayed later can differ if the underlying records changed. Answers are reproducible against the current stored data, not frozen in time
- A fixed retention window bounds live storage growth

### 5.2 Data modeling guidance

The exact schema is **open for discussion**, but these constraints are decided:

- **Do not force everything into a generic `event/value` table.** Thermal detections, wildlife observations, and weather readings have different meanings, units, and fields. Use separate typed tables, sharing common columns (location, time, provenance)
- **Spatial data uses PostGIS** (`geography(Point, 4326)` or equivalent) with spatial indexes. Use geography type so `ST_DWithin` distances are in metres
- **Time columns are distinct and explicit.** At minimum: when the thing happened (`observed_at` / acquisition time), when the source published or created it (where available), and when we retrieved it (`retrieved_at`). Never turn an old observation into a current one because it was downloaded today
- **Provenance on every record:** source name, source record ID, source URL (link to the original observation or dataset), license/attribution, ingestion run ID
- **Positional uncertainty** is stored when available and treated as unknown (not zero) when missing
- **Quality grade** (iNaturalist) is stored on every record. The default display/analysis filter must be **the same in both modes** so Live and CZU are comparable. Note: fresh live observations are mostly "needs ID," while GBIF-derived CZU counts were research-grade only. **Which default to use is open for discussion**
- **Mode/dataset membership:** a way to associate records with the Live region or the CZU case study (e.g. a datasets/presets table with bbox, time window, period boundaries)
- **Pre-aggregated time buckets** (e.g. hourly or daily counts per source, per animal group) to keep timeline scrubbing fast

### 5.3 Handling stale, missing, and conflicting data

This is an explicit evaluation criterion, so it is a product feature, not an afterthought.

- **Stale:** per-source freshness indicators. Keep two things separate: **feed health** (did the last poll succeed, and on schedule?) and **data recency** (how old is the newest record?). An old newest thermal detection with healthy polling means no recent qualifying activity, not a broken feed. Warn clearly when polling has failed or fallen behind its expected cadence
- **Missing:** empty results are stated plainly ("No qualifying thermal detections in this area during the selected period"). Absence of observations is never presented as absence of animals
- **Upload lag:** the most recent hours of iNaturalist data are visibly marked as likely incomplete
- **Conflicting / uncertain:** positional uncertainty, off-perimeter thermal detections, modeled vs measured weather, and quality grades are surfaced rather than hidden
- **Failed ingestion:** a failed run leaves the previous data intact and the UI shows the source as degraded

---

## 6. The agent

### 6.1 Role

**The map and timeline handle selection. The agent handles analysis.** Users should not need to ask the agent to "show August 23 in Santa Cruz"; the UI does that. The agent answers questions that require combining and interpreting data across sources.

The agent is aware of the current UI context (active mode, selected time window, selected region or map selection) and uses it as the default scope for questions.

### 6.2 Architecture

- An LLM with **tool calling** over a small set of **deterministic, typed query tools** backed by SQL/PostGIS
- The LLM **never writes SQL** and never receives thousands of raw rows. Tools return summarized results plus evidence
- Tool arguments are **validated** (schema validation, bounded ranges, bbox limits, max time windows)
- Bounded execution: max tool calls per question, timeouts, graceful failure messages
- **No RAG / vector search.** These are exact spatial, temporal, and numerical queries; embeddings are the wrong tool. Be ready to explain this choice
- LLM provider: Anthropic Claude via the Vercel AI SDK (see section 9)

### 6.3 Tool contract

Every tool returns results, evidence, coverage, and limitations together. Evidence is attached to each result, **not** looked up afterwards. Approximate shape:

```ts
{
  result: { /* the computed answer data */ },
  evidence: [
    {
      source: "inaturalist" | "firms" | "open-meteo",
      sourceId: string,
      sourceUrl: string,
      observedAt: string,
      retrievedAt: string
    }
  ],
  coverage: {
    region: /* bbox or area */,
    timeRange: { start: string, end: string },
    filters: { /* quality grade, taxa, confidence, etc. */ },
    complete: boolean
  },
  limitations: string[],   // e.g. "positional uncertainty unknown for 92% of records"
  insufficient?: { reason: string }  // set when the data can't support the requested analysis
}
```

**Aggregate evidence:** a handful of example records cannot substantiate a total like "1,349 observations." Aggregate results must also carry the exact filters, the matched count, the dataset/ingestion-run provenance, and a way for the user to inspect the full set of matching records (e.g. a reproducible query the UI can open as a list or map filter). Individual example records can accompany that.

### 6.4 Candidate tools

To be refined; roughly 4 to 6 tools done well beats many shallow ones.

- **Compare observations across periods or windows:** counts, per-day rates (normalized for unequal period lengths), animal-group breakdown
- **Top species in a window:** most frequently recorded species with counts
- **Observations near thermal activity:** wildlife records within N km of detections, restricted to records with acceptable positional uncertainty, with approximate distances. The **temporal relationship must be explicit**: the detection time window, the observation time window, and the allowed gap between them (an observation near a spot that burned weeks earlier is different from one near a same-day detection). Both the distance and the time windows are stated in the answer
- **Spatial distribution:** how observations are distributed across the region (e.g. quadrants or grid cells) and whether that shifted between periods
- **Weather context:** modeled conditions for a location/time range, or around peak thermal activity
- **Source freshness/coverage:** what data exists for a window and how fresh or complete it is

### 6.5 Deterministic guardrails (enforced in tools, not just the prompt)

- **Minimum-count thresholds:** species-level or group-level trend or percentage-change comparisons are refused below a threshold (e.g. n < 5 in any compared period) and return `insufficient` with a reason. Factual low-count summaries ("recorded 2 times before, 0 after") are still allowed. The threshold is a sparsity guardrail, not statistical validation, and answers must not imply significance. Many CZU species are recorded only once
- Rates are normalized by period length when periods differ
- Proximity analyses exclude or flag records with unknown or large positional uncertainty

### 6.6 Answer behavior

- Answers cite their evidence; cited records are **highlighted on the map and timeline** so users can follow evidence to its source
- Answers include relevant limitations briefly, without drowning the answer in caveats
- The agent **refuses or qualifies** claims about: population change, mortality, displacement, migration, recovery, causation, exact fire boundaries, and absence inferred from missing observations
- Example of the target behavior:
  - **Q:** "Did the fire cause wildlife populations to decline?"
  - **A:** The data can't establish that. Recorded observations dropped during the active fire period, but iNaturalist records depend on human participation and access, both of which were disrupted by evacuations and closures. I can compare recorded observations, species composition, and where observations were made.
- Always use the phrase **"recorded observations"**, never "wildlife presence" or "population"

### 6.7 Suggested questions

A blank chat box has a discoverability problem, so the UI offers a few contextual suggested questions. Suggestions should **only appear if the current window can answer them** (e.g. don't suggest "wildlife near thermal activity" in Live when there are no recent detections).

Examples for CZU:

- What changed in recorded wildlife observations after the fire?
- Which species were recorded most frequently before and after?
- What were weather conditions during peak thermal activity?
- Why are you saying observations decreased? (evidence)

Examples for Live:

- What species have been recorded in this area this week?
- What wildlife has been observed near recent thermal activity? (only when detections exist)
- What are current conditions here?
- How fresh is the data right now?

---

## 7. Scientific honesty (core design principle)

iNaturalist observations measure **human recording activity** as much as wildlife. During CZU, recorded observations fell from ~45/day before to ~16/day during and ~30/day after. Evacuations, closures, observer participation, seasonality, and detectability are all competing explanations. The app must never present these numbers as population data.

- Metric labels say **"Recorded observations"**
- Where counts are compared, a short visible note explains that observation frequency reflects sampling effort
- FIRMS points are **"satellite thermal detections"**
- Open-Meteo values are **"modeled conditions"**

This honesty is a deliberate strength of the submission, not a weakness to minimize.

---

## 8. Timeline

- Interactive scrubbing and replay (play/pause) over the active window
- Scrubbing operates on **already-loaded data**: no upstream API call and no LLM call on each movement
- Map layers, summary metrics, and weather values update as the timeline moves
- CZU: before / during / after periods are visually marked
- Live: the timeline covers the collected window, with the most recent upload-lag zone marked as likely incomplete
- FIRMS playback reflects discrete satellite pass times
- Timeline granularity, playback speed, and visual design: **Open for discussion**

---

## 9. Tech stack

### Decided

- **Next.js** (App Router) with **TypeScript**
- **Tailwind CSS**
- **Supabase** (Postgres) with **PostGIS** as the new technology
- **Vercel** (Pro plan) for hosting and scheduled ingestion (Vercel Cron)
- Deterministic tool layer in TypeScript
- **MapLibre GL** via **react-map-gl** for the map
- **Anthropic Claude** via the **Vercel AI SDK** for the agent
- **Raw parameterized SQL** with **postgres.js** and plain `.sql` migrations (no ORM)
- **Supabase CLI + Docker** for local development

See [decisions.md](./decisions.md) for alternatives and tradeoffs.

### Open for discussion

- Charting library for timeline and metrics
- Data fetching/caching on the client (Mike knows TanStack Query)
- Whether to store raw upstream payloads alongside normalized records
- How live weather covers California (fixed grid of sample points, points near thermal clusters, on-demand for clicked locations, or a mix)
- Exact cron cadences given rate limits and Vercel function limits

### Secrets / environment

FIRMS MAP_KEY, Supabase connection details, LLM API key. No secrets committed to the repo.

---

## 10. UI / UX

**Open for discussion.** The broad shape is a map-centric single page with a mode switch (Live / CZU 2020), a timeline, layer toggles, source freshness indicators, summary metrics, and an agent panel with suggested questions. Layout, visual style, responsiveness, and interaction details are to be designed together with Mike.

Hard requirements for whatever design is chosen:

- Feels fast and responsive; the timeline scrubs smoothly
- Freshness and data-quality states are visible, not buried
- Evidence cited by the agent is visibly connected to the map/timeline
- Introduced species can be distinguished in the wildlife layer (not labeled "invasive" without an authoritative source)
- Works well on a laptop screen; mobile is a nice-to-have
- Source attribution (NASA FIRMS, iNaturalist, Open-Meteo) is displayed

---

## 11. Non-goals (do not build)

- Authentication, accounts, permissions
- Worldwide or globe views
- Multiple historical fires (CZU only)
- Movebank, earthquakes, GBIF, eBird, air quality integrations
- RAG / vector search
- Three.js or custom 3D
- LLM-generated SQL
- Inferred fire perimeters or fire-spread modeling
- Population modeling or causal ecological analysis
- Chasing test coverage percentages

Stretch ideas, only if the full vertical slice is complete and polished: a fourth source (e.g. earthquakes or eBird as a separate labeled layer), CZU seasonal baselines from prior years, the CZU final fire perimeter as a reference overlay.

---

## 12. Deliverables

- Deployed app at a public URL
- Source repository
- README covering: the question and why it matters, data sources and why they were chosen, architecture overview, key design decisions and tradeoffs (including alternatives considered), data-quality handling, the new technology used, known limitations, and how the system would scale to more data, traffic, users, and use cases
