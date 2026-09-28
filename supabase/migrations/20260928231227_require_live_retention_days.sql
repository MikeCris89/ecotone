-- The original check let a live dataset have a null retention_days: `null > 0` is unknown, and
-- CHECK constraints only reject false. Replace it (it was auto-named datasets_check2) with a
-- named version that requires the value explicitly.
alter table datasets drop constraint datasets_check2;

alter table datasets add constraint datasets_window_check check (
	(
		kind = 'live' and retention_days is not null and retention_days > 0
		and start_date is null and end_date is null
	)
	or (
		kind = 'historical' and retention_days is null
		and start_date is not null and end_date is not null and start_date <= end_date
	)
);
