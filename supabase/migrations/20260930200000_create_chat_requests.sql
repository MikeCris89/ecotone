-- One row per chat request. The rate limits count these rows, and they log what each message
-- cost. No message content, and client IPs only as a keyed hash.
create table chat_requests (
	id bigint generated always as identity primary key,
	created_at timestamptz not null default now(),
	-- Two separate quotas, so public traffic can't use up the reviewers'.
	bucket text not null check (bucket in ('public', 'reviewer')),
	-- HMAC-SHA256 of the client IP with IP_HASH_SECRET: a plain hash of an IPv4 address can be
	-- reversed by hashing all 4 billion.
	ip_hash text not null,
	-- The limit that turned the request away; null when it was served. Only served requests count
	-- toward the limits.
	limited text check (limited in ('hourly', 'daily')),
	-- Filled in when the reply finishes. Null on a served request: the client left, or the model
	-- call failed.
	finished_at timestamptz,
	duration_ms integer,
	input_tokens integer,
	output_tokens integer,
	cache_read_tokens integer,
	cache_write_tokens integer,
	steps integer,
	-- The reply ended without answer text, e.g. the model called a tool on its last step.
	no_answer boolean
);

-- The limit checks: a bucket's served requests since midnight PT, and one IP's in the last hour.
create index chat_requests_served on chat_requests (bucket, created_at) where limited is null;
create index chat_requests_served_by_ip on chat_requests (bucket, ip_hash, created_at) where limited is null;

-- See the datasets migration: closes the table to the public Data API roles.
alter table chat_requests enable row level security;
