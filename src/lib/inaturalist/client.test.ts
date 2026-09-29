import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchObservationsPage } from "@/lib/inaturalist/client";

const query = {
	bbox: { west: -124.5, south: 32.5, east: -114.1, north: 42 },
	updatedSince: new Date("2026-09-29T00:00:00Z"),
	observedFrom: "2026-09-22",
	page: 1,
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("fetchObservationsPage", () => {
	it("retries when fetch throws a network error", async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(Response.json({ results: [{ id: 1, updated_at: "2026-09-29T00:00:00Z" }] }));
		vi.stubGlobal("fetch", fetch);

		const page = fetchObservationsPage({ ...query, deadline: Date.now() + 60_000 });
		await vi.runAllTimersAsync();

		await expect(page).resolves.toEqual([{ id: 1, updated_at: "2026-09-29T00:00:00Z" }]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("gives up on repeated network errors after the retry limit", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		vi.stubGlobal("fetch", fetch);

		const page = fetchObservationsPage({ ...query, deadline: Date.now() + 60_000 });
		const assertion = expect(page).rejects.toThrow("fetch failed");
		await vi.runAllTimersAsync();

		await assertion;
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("doesn't retry when the backoff would run past the deadline", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 429 }));
		vi.stubGlobal("fetch", fetch);

		await expect(fetchObservationsPage({ ...query, deadline: Date.now() + 2_000 })).rejects.toThrow(
			"iNaturalist responded 429",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("doesn't start a request once the deadline has passed", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);

		await expect(fetchObservationsPage({ ...query, deadline: Date.now() - 1 })).rejects.toThrow(
			"deadline reached",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
