const DAY_MS = 24 * 60 * 60_000;

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

// The instant a calendar date (YYYY-MM-DD) begins in the given IANA timezone.
export function startOfLocalDate(date: string, timeZone: string): Date {
	const utcMidnight = Date.parse(`${date}T00:00:00Z`);
	// The offset at UTC midnight can differ from the one at local midnight when a DST change falls
	// between them, so look it up again at the first estimate.
	const estimate = utcMidnight - utcOffsetMs(utcMidnight, timeZone);
	return new Date(utcMidnight - utcOffsetMs(estimate, timeZone));
}

// The calendar date after `date` (YYYY-MM-DD).
export function nextDate(date: string): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

// How far the timezone's clock is ahead of UTC at an instant, e.g. -7 hours for Pacific Daylight Time.
function utcOffsetMs(instant: number, timeZone: string): number {
	const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
		.formatToParts(instant)
		.find((part) => part.type === "timeZoneName")!.value;
	// "GMT-07:00", or plain "GMT" for a zero offset.
	const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
	if (!match) return 0;
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return (match[1] === "-" ? -1 : 1) * minutes * 60_000;
}
