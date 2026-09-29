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
});

describe("fetchObservationsPage", () => {
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
