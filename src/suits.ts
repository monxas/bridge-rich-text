/**
 * Single source of truth for the four bridge suits. Nothing else in the
 * codebase hard-codes a suit symbol or colour.
 */
export type BridgeSuit = "spades" | "hearts" | "diamonds" | "clubs";

export interface SuitDefinition {
	symbol: string;
	color: string;
	label: string;
}

export const BRIDGE_SUITS: Readonly<Record<BridgeSuit, SuitDefinition>> = {
	spades: { symbol: "♠", color: "#111111", label: "Spades" },
	hearts: { symbol: "♥", color: "#DC0000", label: "Hearts" },
	diamonds: { symbol: "♦", color: "#DC0000", label: "Diamonds" },
	clubs: { symbol: "♣", color: "#008A35", label: "Clubs" },
};

export const DEFAULT_SUIT: BridgeSuit = "spades";

export function isBridgeSuit(value: unknown): value is BridgeSuit {
	return typeof value === "string" && Object.hasOwn(BRIDGE_SUITS, value);
}

export function resolveSuit(value: unknown): BridgeSuit {
	return isBridgeSuit(value) ? value : DEFAULT_SUIT;
}
