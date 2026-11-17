/**
 * Turns what the user copied (RTF, HTML or plain text, as read from the
 * clipboard by the native helper) into a small RichText snippet.
 *
 * Only character formatting is kept: colour, font, size, bold, italic.
 * Everything else (paragraphs, styles, lists, images, fields' code) is
 * dropped on purpose: the snippet is rebuilt with the minimal generators in
 * richtext.ts, so a few bytes are stored per key instead of Word's tens of KB
 * of RTF, and each attribute can be switched on or off per key.
 */
import type { RichRun, RichText } from "./richtext";

export interface Captured {
	text?: string;
	rtf?: string;
	html?: string;
}

export type CaptureSource = "rtf" | "html" | "text";

export interface CaptureResult {
	runs: RichRun[];
	source: CaptureSource;
}

/** Longest snippet a key may hold, in UTF-16 code units. */
export const MAX_SNIPPET_LENGTH = 500;

const SAFE_FONT = /^[\p{L}\p{N} ._&+-]{1,64}$/u;
const cleanFont = (font: string | undefined) => {
	const f = font?.trim().replace(/^["']|["']$/g, "");
	return f && SAFE_FONT.test(f) ? f : undefined;
};
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

/** Joins neighbouring runs with identical formatting; drops empty runs. */
export function mergeRuns(runs: readonly RichRun[]): RichRun[] {
	const out: RichRun[] = [];
	const key = (r: RichRun) => JSON.stringify([r.color, r.font, r.sizePt, r.bold, r.italic]);
	for (const run of runs) {
		if (!run.text) continue;
		const last = out[out.length - 1];
		if (last && key(last) === key(run)) last.text += run.text;
		else out.push({ ...run });
	}
	return out;
}

/** Removes leading/trailing line breaks (Word adds one when the paragraph mark is selected). */
function trimBreaks(runs: RichRun[]): RichRun[] {
	while (runs.length && /^[\r\n]*$/.test(runs[0].text)) runs.shift();
	while (runs.length && /^[\r\n]*$/.test(runs[runs.length - 1].text)) runs.pop();
	if (runs.length) {
		runs[0] = { ...runs[0], text: runs[0].text.replace(/^[\r\n]+/, "") };
		const i = runs.length - 1;
		runs[i] = { ...runs[i], text: runs[i].text.replace(/[\r\n]+$/, "") };
	}
	return runs.filter((r) => r.text);
}

function limit(runs: RichRun[]): RichRun[] {
	let left = MAX_SNIPPET_LENGTH;
	const out: RichRun[] = [];
	for (const run of runs) {
		if (left <= 0) break;
		out.push(run.text.length > left ? { ...run, text: run.text.slice(0, left) } : run);
		left -= run.text.length;
	}
	return out;
}

// ---------------------------------------------------------------- RTF

/** Destinations whose content is never visible text. */
const SKIP_DESTINATIONS = new Set([
	"stylesheet", "info", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "mmathPr",
	"themedata", "colorschememapping", "latentstyles", "datastore", "pict", "object", "header", "footer",
	"headerl", "headerr", "headerf", "footerl", "footerr", "footerf", "footnote", "annotation", "filetbl",
	"revtbl", "pgdsctbl", "pntext", "pntxta", "pntxtb", "listtext", "fldinst", "bkmkstart", "bkmkend",
	"shp", "shpinst", "nonshppict", "background", "userprops", "docvar", "wgrffmtfilter", "defchp", "defpap",
]);

interface RtfState {
	font?: number;
	halfPoints: number;
	color: number;
	bold: boolean;
	italic: boolean;
	hidden: boolean;
	uc: number;
	/** Inside a destination that produces no text (or a table handled separately). */
	skip: boolean;
	table?: "font" | "color";
}

const decoder1252 = new TextDecoder("windows-1252");

/** Symbol font positions 0xA7-0xAA (also as U+F0A7-U+F0AA) are ♣ ♦ ♥ ♠. */
const SYMBOL_SUITS: Record<number, string> = { 0xa7: "♣", 0xa8: "♦", 0xa9: "♥", 0xaa: "♠" };

function symbolFontSuits(text: string): string | undefined {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		const mapped = SYMBOL_SUITS[code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code];
		if (mapped === undefined) return undefined;
		out += mapped;
	}
	return out;
}

/**
 * A pragmatic RTF reader for what word processors put on the clipboard:
 * control words, groups, \\uN with \\ucN fallbacks, \\'hh in Windows-1252.
 */
export function parseRtf(rtf: string): RichRun[] {
	const fonts = new Map<number, string>();
	const colors: (string | undefined)[] = [];
	let defaultFont: number | undefined;
	const runs: RichRun[] = [];
	const stack: RtfState[] = [];
	let st: RtfState = { halfPoints: 24, color: 0, bold: false, italic: false, hidden: false, uc: 1, skip: false };
	let skipFallback = 0; // characters still to drop after \uN
	let fontId: number | undefined; // font table entry being read
	let fontName = "";
	let red = 0, green = 0, blue = 0, colorSet = false;
	let groupStart = false; // just after "{", to recognise destinations

	const emit = (text: string) => {
		if (skipFallback > 0) {
			const drop = Math.min(skipFallback, text.length);
			skipFallback -= drop;
			text = text.slice(drop);
			if (!text) return;
		}
		if (st.skip) return;
		if (st.table === "font") {
			for (const ch of text) {
				if (ch === ";") {
					if (fontId !== undefined && fontName.trim()) fonts.set(fontId, fontName.trim());
					fontName = "";
				} else fontName += ch;
			}
			return;
		}
		if (st.table === "color") {
			for (const ch of text) {
				if (ch !== ";") continue;
				colors.push(colorSet ? toHex(red, green, blue) : undefined);
				red = green = blue = 0;
				colorSet = false;
			}
			return;
		}
		if (st.hidden) return;
		const fontNumber = st.font ?? defaultFont;
		let font = fontNumber === undefined ? undefined : fonts.get(fontNumber);
		if (font === "Symbol") {
			// Word's Insert > Symbol with the Symbol font: map its card suits to Unicode.
			const mapped = symbolFontSuits(text);
			if (mapped !== undefined) {
				text = mapped;
				font = undefined;
			}
		}
		runs.push({
			text,
			color: colors[st.color],
			font: cleanFont(font),
			sizePt: st.halfPoints / 2,
			bold: st.bold,
			italic: st.italic,
		});
	};

	const control = (word: string, param: number | undefined) => {
		const on = param !== 0;
		if (groupStart && SKIP_DESTINATIONS.has(word)) st.skip = true;
		switch (word) {
			case "fonttbl": st.table = "font"; break;
			case "colortbl": st.table = "color"; break;
			case "deff": defaultFont = param; break;
			case "f":
				if (st.table === "font") { fontId = param; fontName = ""; }
				else st.font = param;
				break;
			case "fs": if (param && param > 0) st.halfPoints = param; break;
			case "cf": st.color = param ?? 0; break;
			case "red": red = param ?? 0; colorSet = true; break;
			case "green": green = param ?? 0; colorSet = true; break;
			case "blue": blue = param ?? 0; colorSet = true; break;
			case "b": st.bold = on; break;
			case "i": st.italic = on; break;
			case "v": st.hidden = on; break;
			case "plain": Object.assign(st, { font: undefined, halfPoints: 24, color: 0, bold: false, italic: false, hidden: false }); break;
			case "uc": st.uc = param ?? 1; break;
			case "u":
				if (param !== undefined) {
					emit(String.fromCharCode(param < 0 ? param + 0x10000 : param));
					skipFallback = st.uc;
				}
				break;
			case "par": case "line": case "sect": emit("\n"); break;
			case "tab": emit("\t"); break;
			case "emdash": emit("\u2014"); break;
			case "endash": emit("\u2013"); break;
			case "lquote": emit("\u2018"); break;
			case "rquote": emit("\u2019"); break;
			case "ldblquote": emit("\u201C"); break;
			case "rdblquote": emit("\u201D"); break;
			case "bullet": emit("\u2022"); break;
		}
	};

	let i = 0;
	while (i < rtf.length) {
		const ch = rtf[i];
		if (ch === "{") {
			stack.push({ ...st });
			groupStart = true;
			i++;
			continue;
		}
		if (ch === "}") {
			if (st.table === "font" && fontId !== undefined && fontName.trim() && !fonts.has(fontId)) fonts.set(fontId, fontName.trim());
			st = stack.pop() ?? st;
			groupStart = false;
			i++;
			continue;
		}
		if (ch === "\\") {
			const next = rtf[i + 1];
			if (next === undefined) break;
			if (/[a-zA-Z]/.test(next)) {
				const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 48))!;
				control(m[1], m[2] === undefined ? undefined : Number(m[2]));
				groupStart = false;
				i += 1 + m[0].length;
				continue;
			}
			groupStart = groupStart && next === "*";
			if (next === "*") st.skip = true; // \* = ignorable destination we do not know
			else if (next === "'") {
				const byte = parseInt(rtf.slice(i + 2, i + 4), 16);
				if (!Number.isNaN(byte)) emit(decoder1252.decode(Uint8Array.of(byte)));
				i += 4;
				continue;
			} else if (next === "~") emit("\u00A0");
			else if (next === "_") emit("\u2011");
			else if (next === "\n" || next === "\r") emit("\n");
			else if (next !== "-") emit(next); // \\ \{ \} and other literal symbols
			i += 2;
			continue;
		}
		groupStart = false;
		if (ch === "\r" || ch === "\n") {
			i++;
			continue;
		}
		let j = i;
		while (j < rtf.length && !"\\{}\r\n".includes(rtf[j])) j++;
		emit(rtf.slice(i, j));
		i = j;
	}
	return mergeRuns(runs);
}

// ---------------------------------------------------------------- HTML

const NAMED_COLORS: Record<string, string> = {
	black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF",
	gray: "#808080", grey: "#808080", darkred: "#8B0000", darkgreen: "#006400", navy: "#000080",
	maroon: "#800000", orange: "#FFA500", purple: "#800080", yellow: "#FFFF00",
};

export function parseCssColor(value: string): string | undefined {
	const v = value.trim().toLowerCase();
	let m = /^#([0-9a-f]{6})$/.exec(v);
	if (m) return `#${m[1]}`.toUpperCase();
	m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
	if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase();
	m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
	if (m) return toHex(Number(m[1]), Number(m[2]), Number(m[3]));
	return NAMED_COLORS[v];
}

function parseCssSize(value: string): number | undefined {
	const m = /^([\d.]+)\s*(pt|px)$/.exec(value.trim().toLowerCase());
	if (!m) return undefined;
	const n = Number(m[1]) * (m[2] === "px" ? 0.75 : 1);
	return n >= 1 && n <= 1638 ? Math.round(n * 2) / 2 : undefined;
}

function decodeEntities(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0", spades: "♠", hearts: "♥", diams: "♦", clubs: "♣" };
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
		}
		return named[e.toLowerCase()] ?? all;
	});
}

/** The fragment of a CF_HTML document, or the body of a plain HTML document. */
function htmlFragmentOf(html: string): string {
	const start = html.indexOf("<!--StartFragment-->");
	const end = html.indexOf("<!--EndFragment-->");
	if (start >= 0 && end > start) return html.slice(start + "<!--StartFragment-->".length, end);
	const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
	return body ? body[1] : html.replace(/^[\s\S]*?(?=<)/, "");
}

type HtmlFormat = Omit<RichRun, "text">;

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "col"]);

export function parseHtml(html: string): RichRun[] {
	const source = htmlFragmentOf(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, "");
	const runs: RichRun[] = [];
	const stack: { tag: string; fmt: HtmlFormat }[] = [];
	let fmt: HtmlFormat = {};
	const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9:]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = tokens.exec(source))) {
		if (m[4] !== undefined) {
			const text = decodeEntities(m[4].replace(/[ \t\r\n]+/g, " "));
			if (text) runs.push({ text, ...fmt });
			continue;
		}
		const tag = m[2].toLowerCase();
		if (m[1]) {
			const at = stack.map((s) => s.tag).lastIndexOf(tag);
			if (at >= 0) {
				fmt = stack[at].fmt;
				stack.length = at;
			}
			if (BLOCK_TAGS.has(tag)) runs.push({ text: "\n", ...fmt });
			continue;
		}
		if (tag === "br") {
			runs.push({ text: "\n", ...fmt });
			continue;
		}
		if (VOID_TAGS.has(tag) || m[3].trimEnd().endsWith("/")) continue;
		stack.push({ tag, fmt });
		const next: HtmlFormat = { ...fmt };
		if (tag === "b" || tag === "strong") next.bold = true;
		if (tag === "i" || tag === "em") next.italic = true;
		const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(m![3]);
		const attrValue = (name: string) => {
			const a = attr(name);
			return a ? decodeEntities(a[2] ?? a[3] ?? a[4] ?? "") : undefined;
		};
		if (tag === "font") {
			const color = attrValue("color");
			if (color && parseCssColor(color)) next.color = parseCssColor(color);
			const face = cleanFont(attrValue("face")?.split(",")[0]);
			if (face) next.font = face;
		}
		for (const decl of (attrValue("style") ?? "").split(";")) {
			const colon = decl.indexOf(":");
			if (colon < 0) continue;
			const prop = decl.slice(0, colon).trim().toLowerCase();
			const value = decl.slice(colon + 1).replace(/!important/i, "").trim();
			if (prop === "color") next.color = parseCssColor(value) ?? next.color;
			else if (prop === "font-family") next.font = cleanFont(value.split(",")[0]) ?? next.font;
			else if (prop === "font-size") next.sizePt = parseCssSize(value) ?? next.sizePt;
			else if (prop === "font-weight") next.bold = value === "bold" || value === "bolder" || Number(value) >= 600;
			else if (prop === "font-style") next.italic = value === "italic" || value === "oblique";
		}
		fmt = next;
	}
	// HTML whitespace: a space next to a line break is not visible.
	const merged = mergeRuns(runs);
	for (const run of merged) run.text = run.text.replace(/ *\n */g, "\n");
	if (merged.length) merged[0].text = merged[0].text.trimStart();
	if (merged.length) merged[merged.length - 1].text = merged[merged.length - 1].text.trimEnd();
	return merged.filter((r) => r.text);
}

// ---------------------------------------------------------------- choice

const plain = (runs: readonly RichRun[]) => runs.map((r) => r.text).join("");

/**
 * Best snippet from a capture: RTF (what Word and most word processors
 * offer, with exact colours and fonts), then HTML (browsers), then text.
 */
export function snippetFromCapture(captured: Captured): CaptureResult | undefined {
	const text = captured.text?.replace(/\r\n/g, "\n");
	const attempts: [CaptureSource, () => RichRun[]][] = [
		["rtf", () => (captured.rtf ? parseRtf(captured.rtf) : [])],
		["html", () => (captured.html ? parseHtml(captured.html) : [])],
		["text", () => (text ? [{ text }] : [])],
	];
	for (const [source, parse] of attempts) {
		let runs: RichRun[];
		try {
			runs = limit(trimBreaks(parse()));
		} catch {
			continue;
		}
		if (plain(runs).trim()) return { runs, source };
	}
	return undefined;
}

export { plain as snippetText };
export type { RichText };
