// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a configured secret, nothing passes.
export function isAuthorizedCron(request: Request): boolean {
	const secret = process.env.CRON_SECRET;
	return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}
