/**
 * Custom snippets: text the user copied (a symbol, "♠AKQ", "1NT"...) stored
 * per key as RichText runs, inserted through the same paste pipeline as the
 * suits.
 */
import type { CaptureSource } from "./capture";
import type { InsertionFormat, PasteRequest } from "./paste-helper";
import { buildClipboardPayload, htmlFragment, isPasteFormats, plainText, type PasteFormats, type RichRun, type RichText } from "./richtext";
import { effectiveFormats } from "./suit-payload";
import { SUIT_PATHS } from "./render";
import { BRIDGE_SUITS, type BridgeSuit } from "./suits";

/** A stored run. A type alias (not an interface) so it satisfies the SDK's JsonObject. */
export type SnippetRun = {
	text: string;
	color?: string;
	font?: string;
	sizePt?: number;
	bold?: boolean;
	italic?: boolean;
};

export type SnippetSettings = {
	snippet?: SnippetRun[];
	/** Where the snippet came from: "rtf", "html" or "text" (no formatting). */
	source?: string;
	/** Keep the captured colour. Default true. */
	keepColor?: boolean;
	/** Keep the captured font; otherwise the font at Word's cursor. Default false. */
	keepFont?: boolean;
	/** Keep the captured size; otherwise the size at Word's cursor. Default false. */
	keepSize?: boolean;
	/** Keep the captured bold/italic. Default true. */
	keepStyle?: boolean;
	formats?: PasteFormats;
	resetWordFormatting?: boolean;
};

export interface KeepOptions {
	color: boolean;
	font: boolean;
	size: boolean;
	style: boolean;
}

export function keepOptions(s: SnippetSettings): KeepOptions {
	return { color: s.keepColor !== false, font: s.keepFont === true, size: s.keepSize === true, style: s.keepStyle !== false };
}

/** True when probing Word for the font/size at the cursor is worth it. */
export function needsProbe(s: SnippetSettings): boolean {
	const keep = keepOptions(s);
	return !keep.font || !keep.size;
}

const SUIT_CHARS = /[♠♥♦♣♤♡♢♧]/u;

/**
 * Fonts whose characters are pictures, not letters: Wingdings 232 is an arrow,
 * but "è" in any other font. Their font is always kept, whatever keepFont says.
 */
const SYMBOL_FONTS = /^(wingdings( [23])?|webdings|symbol|marlett|mt extra|zapf ?dingbats|segoe mdl2 assets|segoe fluent icons)$/i;
export const isSymbolFont = (font: string | undefined) => !!font && SYMBOL_FONTS.test(font.trim());

/**
 * The runs to insert: captured attributes that are kept, the cursor's font
 * and size for the others. Runs with suit symbols get the probe's glyph-safe
 * font; other text gets the document font as is.
 */
export function snippetRichText(runs: readonly SnippetRun[], keep: KeepOptions, cursor: InsertionFormat = {}): RichText {
	return runs.map((run): RichRun => {
		const cursorFont = SUIT_CHARS.test(run.text) ? cursor.font : (cursor.docFont ?? cursor.font);
		return {
			text: run.text,
			color: keep.color ? run.color : undefined,
			font: keep.font || isSymbolFont(run.font) ? run.font : cursorFont,
			sizePt: keep.size ? run.sizePt : cursor.sizePt,
			bold: keep.style ? run.bold : undefined,
			italic: keep.style ? run.italic : undefined,
		};
	});
}

export function snippetRequestFor(
	settings: SnippetSettings,
	cursor: InsertionFormat = {},
	platform: NodeJS.Platform = process.platform,
): PasteRequest | undefined {
	if (!settings.snippet?.length || !plainText(settings.snippet)) return undefined;
	const formats = effectiveFormats(isPasteFormats(settings.formats) ? settings.formats : "auto", platform);
	return {
		...buildClipboardPayload(snippetRichText(settings.snippet, keepOptions(settings), cursor), formats),
		resetWordFormatting: settings.resetWordFormatting !== false,
	};
}

/** What the property inspector shows under the Capture button. */
export type SnippetPreview = { preview: string; source?: string; message: string };

const SOURCE_NOTES: Record<CaptureSource, string> = {
	rtf: "Captured with formatting.",
	html: "Captured with formatting (from HTML).",
	text: "The clipboard had plain text only: no colour or font was captured.",
};

export function previewOf(settings: SnippetSettings): SnippetPreview {
	if (!settings.snippet?.length) return { preview: "", message: "Copy the text you want in Word (or anywhere), then press Capture." };
	// Shown as the key will insert it, with the cursor's font left to the PI's default.
	const preview = htmlFragment(snippetRichText(settings.snippet, keepOptions(settings), {}));
	const source = settings.source as CaptureSource | undefined;
	return { preview, source, message: (source && SOURCE_NOTES[source]) ?? "" };
}

// ---------------------------------------------------------------- key image

const KEY_BACKGROUND = "#262626";
const escapeXml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const safeColor = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black and dark greys (every channel low); dark reds, greens and blues are not. */
const nearBlack = (hex: string) => [1, 3, 5].every((i) => parseInt(hex.slice(i, i + 2), 16) < 0x50);

const SUIT_BY_SYMBOL = new Map(Object.entries(BRIDGE_SUITS).map(([k, v]) => [v.symbol, k as BridgeSuit]));

/**
 * Key image for a snippet. A lone suit symbol is drawn with the suit's SVG
 * shape in the captured colour; other text as SVG text, shortened to what
 * fits. Dark colours get a light outline so they stay visible on the key.
 */
export function snippetKeySvg(runs: readonly SnippetRun[] | undefined): string {
	const open = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${KEY_BACKGROUND}"/>`;
	const text = runs ? plainText(runs).replace(/[\uFE0E\uFE0F]/g, "").trim() : "";
	if (!text) {
		return `${open}<text x="72" y="84" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#9A9A9A">Capture</text></svg>`;
	}
	const visible = (runs ?? []).filter((r) => r.text.trim());
	const outline = (color: string) => (luminance(color) < 0.2 ? ` stroke="#9A9A9A" stroke-width="2.5" stroke-linejoin="round" paint-order="stroke"` : "");
	const suit = SUIT_BY_SYMBOL.get(text);
	if (suit) {
		const color = safeColor(visible[0]?.color, BRIDGE_SUITS[suit].color);
		return `${open}<g transform="translate(22 22)"><path d="${SUIT_PATHS[suit]}" fill="${color}"${outline(color)}/></g></svg>`;
	}
	const chars = [...text.replace(/\s+/g, " ")];
	// Up to 5 characters; longer text shows its first 4 and an ellipsis.
	const shown = chars.length > 5 ? 4 : chars.length;
	const size = [0, 96, 64, 48, 38, 30][Math.min(chars.length, 5)];
	let left = shown;
	const spans: string[] = [];
	for (const run of visible) {
		if (left <= 0) break;
		const part = [...run.text.replace(/[\uFE0E\uFE0F]/g, "").replace(/\s+/g, " ")].slice(0, left);
		left -= part.length;
		// On the dark key, text too dark to read (black, #111111...) is drawn white;
		// the colour pasted into the document is unchanged.
		const captured = safeColor(run.color, "#FFFFFF");
		const color = nearBlack(captured) ? "#FFFFFF" : captured;
		// U+FE0E asks for the text (not emoji) presentation of symbols such as ♥.
		// Symbol fonts (Wingdings...) draw their pictures at U+F020-U+F0FF; "è" itself
		// would be drawn as a letter by a fallback font.
		const symbol = isSymbolFont(run.font);
		const glyphs = symbol ? part.join("").replace(/[ -ÿ]/g, (c) => String.fromCharCode(0xf000 + c.charCodeAt(0))) : part.join("");
		const body = escapeXml(glyphs).replace(/([♠♥♦♣])/gu, "$1\uFE0E");
		const weight = run.bold ? ` font-weight="bold"` : "";
		const style = run.italic ? ` font-style="italic"` : "";
		const family = symbol ? ` font-family="${escapeXml(run.font!)}"` : "";
		spans.push(`<tspan fill="${color}"${outline(color)}${weight}${style}${family}>${body}</tspan>`);
	}
	if (chars.length > shown) spans.push(`<tspan fill="#9A9A9A">…</tspan>`);
	const font = visible.find((r) => r.font)?.font;
	const family = escapeXml([font, "Segoe UI Symbol", "Segoe UI", "Arial", "sans-serif"].filter(Boolean).join(", "));
	return `${open}<text x="72" y="${72 + size * 0.36}" text-anchor="middle" font-family="${family}" font-size="${size}">${spans.join("")}</text></svg>`;
}

export function snippetKeyImage(runs: readonly SnippetRun[] | undefined): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(snippetKeySvg(runs))}`;
}
