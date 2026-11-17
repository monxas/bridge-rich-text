// Regenerates the static SVG assets from src/render.ts so they never drift
// from the dynamically rendered key images. Run: npm run icons
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { KEY_BACKGROUND, SUIT_PATHS, suitKeySvg } from "../src/render";
import { snippetKeySvg } from "../src/snippet";
import { BRIDGE_SUITS, type BridgeSuit } from "../src/suits";

const dir = "com.monxas.bridgesuits.sdPlugin/imgs";
const order: BridgeSuit[] = ["spades", "hearts", "diamonds", "clubs"];
// 2x2 grid of suits inside a 100x100 box.
const grid = (fill: (s: BridgeSuit) => string) =>
	order
		.map((s, i) => `<path transform="translate(${(i % 2) * 52 + 2} ${Math.floor(i / 2) * 52 + 2}) scale(0.44)" d="${SUIT_PATHS[s]}" fill="${fill(s)}"/>`)
		.join("");
const svg = (size: number, body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${body}</svg>\n`;
const write = (path: string, content: string) => {
	writeFileSync(`${dir}/${path}`, content);
	console.log(`wrote ${dir}/${path}`);
};

const coloured = (s: BridgeSuit) => (s === "spades" ? "#F2F2F2" : BRIDGE_SUITS[s].color);
// Action list icon + category icon: monochrome white on transparent, as required.
write("actions/insert/icon.svg", svg(20, grid(() => "#FFFFFF")));
write("plugin/category-icon.svg", svg(28, grid(() => "#FFFFFF")));
// Default key image (before a suit is chosen) and plugin icon: coloured grid.
write("actions/insert/key.svg", svg(144, `<rect width="100" height="100" fill="${KEY_BACKGROUND}"/><g transform="translate(10 10) scale(0.8)">${grid(coloured)}</g>`));
// Custom snippet action: a heart with a plus sign; key before anything is captured.
const heartPlus = (fill: string) =>
	`<path transform="translate(0 6) scale(0.72)" d="${SUIT_PATHS.hearts}" fill="${fill}"/><path d="M76 52h10v18h18v10H86v18H76V80H58V70h18z" transform="translate(-6 -4)" fill="${fill}"/>`;
mkdirSync(`${dir}/actions/snippet`, { recursive: true });
write("actions/snippet/icon.svg", svg(20, heartPlus("#FFFFFF")));
write("actions/snippet/key.svg", snippetKeySvg(undefined) + "\n");
// Plugin icon must be PNG: 288x288 and 576x576 (@2x).
const marketplace = svg(288, `<rect width="100" height="100" rx="18" fill="${KEY_BACKGROUND}"/><g transform="translate(10 10) scale(0.8)">${grid(coloured)}</g>`);
for (const [suffix, width] of [["", 288], ["@2x", 576]] as const) {
	writeFileSync(`${dir}/plugin/marketplace${suffix}.png`, new Resvg(marketplace, { fitTo: { mode: "width", value: width } }).render().asPng());
	console.log(`wrote ${dir}/plugin/marketplace${suffix}.png`);
}
// Preview sheet of the four per-suit key images (not shipped).
mkdirSync("dist", { recursive: true });
for (const s of order) writeFileSync(`dist/preview-${s}.png`, new Resvg(suitKeySvg(s)).render().asPng());
const samples = {
	heart: [{ text: "♥", color: "#DC0000" }],
	nt: [{ text: "1", color: "#111111", bold: true }, { text: "NT", color: "#111111" }],
	akq: [{ text: "♠", color: "#111111" }, { text: "AKQ" }],
	long: [{ text: "Stayman 2♣", color: "#008A35" }],
};
for (const [name, runs] of Object.entries(samples))
	writeFileSync(`dist/preview-snippet-${name}.png`, new Resvg(snippetKeySvg(runs), { font: { loadSystemFonts: true } }).render().asPng());
