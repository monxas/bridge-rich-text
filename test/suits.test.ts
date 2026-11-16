import { describe, expect, it } from "vitest";
import { suitKeySvg } from "../src/render";
import { pasteRequestFor } from "../src/suit-payload";
import { BRIDGE_SUITS, resolveSuit } from "../src/suits";

describe("suit definitions", () => {
	it("match the ADR exactly", () => {
		expect(BRIDGE_SUITS.spades).toMatchObject({ symbol: "♠", color: "#111111" });
		expect(BRIDGE_SUITS.hearts).toMatchObject({ symbol: "♥", color: "#DC0000" });
		expect(BRIDGE_SUITS.diamonds).toMatchObject({ symbol: "♦", color: "#DC0000" });
		expect(BRIDGE_SUITS.clubs).toMatchObject({ symbol: "♣", color: "#008A35" });
		for (const s of Object.values(BRIDGE_SUITS)) expect([...s.symbol]).toHaveLength(1); // no U+FE0F variation selector
	});

	it("falls back to spades for missing or unknown settings", () => {
		expect(resolveSuit(undefined)).toBe("spades");
		expect(resolveSuit("toString")).toBe("spades");
		expect(resolveSuit("clubs")).toBe("clubs");
	});
});

describe("paste request", () => {
	it("defaults to HTML + RTF and resetting Word formatting", () => {
		const r = pasteRequestFor({ suit: "hearts" });
		expect(r.text).toBe("♥");
		expect(r.html).toContain('<span style="color:#DC0000">♥</span>');
		expect(r.rtf).toContain("\\red220\\green0\\blue0");
		expect(r.resetWordFormatting).toBe(true);
	});

	it("honours advanced settings", () => {
		const r = pasteRequestFor({ suit: "clubs", formats: "rtf", resetWordFormatting: false });
		expect(r.html).toBeUndefined();
		expect(r.rtf).toContain("\\red0\\green138\\blue53");
		expect(r.resetWordFormatting).toBe(false);
	});
});

describe("key image", () => {
	it("draws each suit in its colour on a dark key", () => {
		for (const [suit, def] of Object.entries(BRIDGE_SUITS)) {
			const svg = suitKeySvg(suit as keyof typeof BRIDGE_SUITS);
			expect(svg).toContain(`fill="${def.color}"`);
			expect(svg).not.toContain("<text"); // paths only: no emoji font fallback
		}
	});
});
