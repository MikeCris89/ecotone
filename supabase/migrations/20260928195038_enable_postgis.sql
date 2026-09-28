-- Supabase convention: extensions live in the `extensions` schema, which is on the
-- default search_path, so `geography(Point, 4326)` and ST_* functions resolve unqualified.
create extension if not exists postgis with schema extensions;
