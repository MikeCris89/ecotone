// The calendar date (YYYY-MM-DD) of an instant in the given IANA timezone.
export function localDate(instant: Date, timeZone: string): string {
	// en-CA formats dates as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(instant);
}
