import { describe, expect, it } from "vitest";
import { isSymbolFont, needsProbe, previewOf, type SnippetRun, snippetKeySvg, snippetRequestFor, snippetRichText } from "../src/snippet";

const RUNS: SnippetRun[] = [
	{ text: "♥", color: "#DC0000", font: "Calibri", sizePt: 11, bold: true, italic: false },
	{ text: " 1NT", font: "Calibri", sizePt: 11, bold: false, italic: false },
];

describe("snippetRichText", () => {
	it("defaults: keep colour and style, take font and size from the cursor", () => {
		const cursor = { font: "Segoe UI Symbol", docFont: "Aptos", sizePt: 12 };
		expect(snippetRichText(RUNS, { color: true, style: true, font: false, size: false }, cursor)).toEqual([
			// suit text gets the glyph-safe font, other text the document font
			{ text: "♥", color: "#DC0000", font: "Segoe UI Symbol", sizePt: 12, bold: true, italic: false },
			{ text: " 1NT", color: undefined, font: "Aptos", sizePt: 12, bold: false, italic: false },
		]);
	});

	it("always keeps a symbol font (Wingdings 232 is an arrow, not è), sized like the cursor", () => {
		// Word's Insert > Symbol > Wingdings arrow, as captured from real Word for Windows.
		const arrow: SnippetRun[] = [{ text: "è", color: "#111111", font: "Wingdings", sizePt: 11, bold: false, italic: false }];
		const cursor = { font: "Segoe UI Symbol", docFont: "Aptos", sizePt: 14 };
		expect(snippetRichText(arrow, { color: true, style: true, font: false, size: false }, cursor)).toEqual([
			{ text: "è", color: "#111111", font: "Wingdings", sizePt: 14, bold: false, italic: false },
		]);
		// Key image: the picture's code point in the symbol font, not the letter.
		const svg = snippetKeySvg(arrow);
		expect(svg).toContain(`font-family="Wingdings"></tspan>`);
		expect(svg).not.toContain("è");
		expect(isSymbolFont("Wingdings 3")).toBe(true);
		expect(isSymbolFont("Webdings")).toBe(true);
		expect(isSymbolFont("Calibri")).toBe(false);
	});

	it("keeps everything captured when asked", () => {
		expect(snippetRichText(RUNS, { color: true, style: true, font: true, size: true }, { font: "X", sizePt: 30 })).toEqual(RUNS);
	});

	it("drops colour and style when not kept", () => {
		const [run] = snippetRichText(RUNS, { color: false, style: false, font: true, size: true });
		expect(run).toEqual({ text: "♥", color: undefined, font: "Calibri", sizePt: 11, bold: undefined, italic: undefined });
	});
});

describe("snippetRequestFor", () => {
	it("builds a paste request with RTF and HTML on Windows", () => {
		const request = snippetRequestFor({ snippet: RUNS }, { font: "Arial", sizePt: 12 }, "win32")!;
		expect(request.text).toBe("♥ 1NT");
		expect(request.rtf).toContain("\\b\\i0 \\u9829?");
		expect(request.html).toContain("color:#DC0000;font-weight:bold");
		expect(request.resetWordFormatting).toBe(true);
	});

	it("returns nothing without a snippet", () => {
		expect(snippetRequestFor({})).toBeUndefined();
		expect(snippetRequestFor({ snippet: [] })).toBeUndefined();
	});

	it("probes the cursor only when font or size come from it", () => {
		expect(needsProbe({})).toBe(true);
		expect(needsProbe({ keepFont: true, keepSize: true })).toBe(false);
	});
});

describe("key image and preview", () => {
	it("draws a lone suit with its shape, other text as text", () => {
		expect(snippetKeySvg([{ text: "♣", color: "#123456" }])).toMatch(/<path d="[^"]+" fill="#123456"/);
		const svg = snippetKeySvg([{ text: "1NT<x>", color: "#000000", bold: true }]);
		expect(svg).toMatch(/>1NT&#60;<\/tspan><tspan fill="#9A9A9A">…</);
		expect(svg).toContain('stroke="#9A9A9A"'); // dark text gets an outline
		expect(snippetKeySvg(undefined)).toContain("Capture");
	});

	it("never puts an unvalidated colour into the SVG", () => {
		expect(snippetKeySvg([{ text: "a", color: '"/><script>' }])).not.toContain("<script>");
	});

	it("previews what the key will insert", () => {
		expect(previewOf({}).preview).toBe("");
		const p = previewOf({ snippet: RUNS, source: "rtf" });
		expect(p.preview).toContain('<span style="color:#DC0000;font-weight:bold;font-style:normal">♥</span>');
		expect(p.message).toMatch(/with formatting/);
		expect(previewOf({ snippet: [{ text: "x" }], source: "text" }).message).toMatch(/plain text only/);
	});
});
