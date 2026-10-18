-- Postgres doesn't index the referencing side of a foreign key. Deleting an ingestion run makes it
-- check each records table for rows still pointing at the run, and without these indexes every
-- check is a full table scan. The daily prune deletes thousands of runs at once, so its first
-- production run timed out after 60 s. These also speed up the prune's own "owns no record" check.
create index inat_observations_ingestion_run_id_idx on inat_observations (ingestion_run_id);
create index firms_detections_ingestion_run_id_idx on firms_detections (ingestion_run_id);
create index weather_readings_ingestion_run_id_idx on weather_readings (ingestion_run_id);
