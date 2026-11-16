import { BRIDGE_SUITS, type BridgeSuit } from "./suits";

/**
 * Suit shapes as SVG paths on a 100x100 grid. Drawn as paths rather than
 * text glyphs so the key never falls back to a colour-emoji font.
 */
export const SUIT_PATHS: Readonly<Record<BridgeSuit, string>> = {
	spades:
		"M50 6C78 30 92 45 92 60C92 73 82 82 70 82C62 82 56 78 52.5 72C53.5 81 57 87 64 93H36C43 87 46.5 81 47.5 72C44 78 38 82 30 82C18 82 8 73 8 60C8 45 22 30 50 6Z",
	hearts:
		"M50 90C20 67 8 51 8 33C8 19 19 9 32 9C40 9 46 13 50 20C54 13 60 9 68 9C81 9 92 19 92 33C92 51 80 67 50 90Z",
	diamonds: "M50 5L84 50L50 95L16 50Z",
	clubs:
		"M50 10A19 19 0 0 1 64.5 41.3A19 19 0 1 1 53 74C54 83 58 88 65 93H35C42 88 46 83 47 74A19 19 0 1 1 35.5 41.3A19 19 0 0 1 50 10Z",
};

export const KEY_BACKGROUND = "#262626";
/** Spades are near-black, so they get a light outline to stay visible on the dark key. */
const SPADES_OUTLINE = "#9A9A9A";

export function suitKeySvg(suit: BridgeSuit): string {
	const { color } = BRIDGE_SUITS[suit];
	const outline = suit === "spades" ? ` stroke="${SPADES_OUTLINE}" stroke-width="2.5" stroke-linejoin="round"` : "";
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" fill="${KEY_BACKGROUND}"/>` +
		`<g transform="translate(22 22)"><path d="${SUIT_PATHS[suit]}" fill="${color}"${outline}/></g>` +
		`</svg>`
	);
}

export function suitKeyImage(suit: BridgeSuit): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(suitKeySvg(suit))}`;
}
