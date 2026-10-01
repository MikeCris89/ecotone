// The evals' sentence checks, which run in `pnpm test`: no network, unlike the evals themselves.
import { describe, expect, it } from "vitest";
import { BANNED_TERMS, CAUSAL_TERMS, unrefused } from "./chat";

describe("unrefused", () => {
	it("flags a banned or causal term whose sentence only negates, without refusing", () => {
		expect(unrefused("The deer population did not recover after the fire.", BANNED_TERMS)).toEqual([
			"The deer population did not recover after the fire.",
		]);
		expect(unrefused("Animals fled the burn and never returned.", CAUSAL_TERMS)).toEqual([
			"Animals fled the burn and never returned.",
		]);
		// "No effect" is a claim too.
		expect(unrefused("Animals did not flee the area.", CAUSAL_TERMS)).toEqual(["Animals did not flee the area."]);
	});

	it("passes a sentence refusing what the agent or the records can show", () => {
		const refusals = [
			"I can't make population claims from these records.",
			"I cannot reliably tell whether the population changed.",
			"I'm unable to determine population trends.",
			"These records don't show whether the fires displaced deer.",
			"The data can't establish that the fires drove deer away.",
		];
		for (const sentence of refusals) {
			expect(unrefused(sentence, BANNED_TERMS), sentence).toEqual([]);
			expect(unrefused(sentence, CAUSAL_TERMS), sentence).toEqual([]);
		}
	});

	it("checks each sentence on its own", () => {
		expect(unrefused("I can't make population claims. The population fell.", BANNED_TERMS)).toEqual([
			"The population fell.",
		]);
	});
});
