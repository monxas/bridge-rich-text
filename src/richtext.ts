/**
 * Clipboard payload generation for small rich-text snippets.
 *
 * A snippet is a list of runs; each run is plain text with an optional
 * foreground colour. Only the colour is ever specified so that the target
 * application keeps its own font family and size where it can.
 */
export interface RichRun {
	text: string;
	/** `#RRGGBB`. Omitted = inherit / automatic colour. */
	color?: string;
	/**
	 * Font family. Omitted = not specified, which most editors replace with
	 * their own default (Word: Times New Roman, or an emoji font for ♠♥♦♣),
	 * so callers that know the font at the insertion point should set it.
	 */
	font?: string;
	/** Font size in points. Omitted = not specified. */
	sizePt?: number;
}

export type RichText = readonly RichRun[];

/** Which rich formats to place on the clipboard. Plain Unicode text is always included. */
export type PasteFormats = "auto" | "html" | "rtf" | "text";

export interface ClipboardPayload {
	/** CF_UNICODETEXT content. */
	text: string;
	/** Complete CF_HTML ("HTML Format") document, header included. */
	html?: string;
	/** "Rich Text Format" document. */
	rtf?: string;
}

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function parseColor(color: string): [number, number, number] {
	const m = HEX_COLOR.exec(color);
	if (!m) throw new Error(`Invalid colour "${color}", expected #RRGGBB`);
	return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function plainText(rich: RichText): string {
	return rich.map((r) => r.text).join("");
}

/** Font names go into CSS and RTF verbatim, so only allow plain names. */
const SAFE_FONT = /^[\p{L}\p{N} ._&+-]{1,64}$/u;

function checkFont(font: string): string {
	if (!SAFE_FONT.test(font)) throw new Error(`Unsupported font name "${font}"`);
	return font;
}

function checkSize(size: number): number {
	if (!Number.isFinite(size) || size < 1 || size > 1638) throw new Error(`Unsupported font size ${size}`);
	return Math.round(size * 2) / 2; // half points, as Word and RTF store them
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function htmlFragment(rich: RichText): string {
	return rich
		.map((run) => {
			const text = escapeHtml(run.text);
			const style: string[] = [];
			if (run.font) style.push(`font-family:'${checkFont(run.font)}'`);
			if (run.sizePt !== undefined) style.push(`font-size:${checkSize(run.sizePt)}pt`);
			if (run.color) {
				parseColor(run.color); // validate, never inject arbitrary CSS
				style.push(`color:${run.color.toUpperCase()}`);
			}
			return style.length ? `<span style="${style.join(";")}">${text}</span>` : text;
		})
		.join("");
}

const START_FRAGMENT = "<!--StartFragment-->";
const END_FRAGMENT = "<!--EndFragment-->";
const OFFSET_DIGITS = 10;

/**
 * Wraps an HTML fragment in a CF_HTML document as specified by
 * https://learn.microsoft.com/windows/win32/dataxchg/html-clipboard-format
 *
 * Offsets are byte offsets into the UTF-8 encoded clipboard data, counted
 * from the start of the header. They are zero-padded to a fixed width so the
 * header length does not depend on their values.
 */
export function buildCfHtml(fragment: string): string {
	const prefix =
		"<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\"></head><body>" + START_FRAGMENT;
	const suffix = END_FRAGMENT + "</body></html>";
	const placeholder = "0".repeat(OFFSET_DIGITS);
	const headerTemplate = (startHtml: string, endHtml: string, startFrag: string, endFrag: string) =>
		`Version:0.9\r\nStartHTML:${startHtml}\r\nEndHTML:${endHtml}\r\nStartFragment:${startFrag}\r\nEndFragment:${endFrag}\r\n`;

	const headerLength = Buffer.byteLength(headerTemplate(placeholder, placeholder, placeholder, placeholder), "utf8");
	const startHtml = headerLength;
	const startFragment = startHtml + Buffer.byteLength(prefix, "utf8");
	const endFragment = startFragment + Buffer.byteLength(fragment, "utf8");
	const endHtml = endFragment + Buffer.byteLength(suffix, "utf8");

	const pad = (n: number) => String(n).padStart(OFFSET_DIGITS, "0");
	return headerTemplate(pad(startHtml), pad(endHtml), pad(startFragment), pad(endFragment)) + prefix + fragment + suffix;
}

function rtfEscape(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i); // UTF-16 code units, as RTF \u expects
		const ch = text[i];
		if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
		else if (ch === "\n") out += "\\line ";
		else if (unit >= 0x20 && unit < 0x80) out += ch;
		else out += `\\u${unit > 0x7fff ? unit - 0x10000 : unit}?`;
	}
	return out;
}

/**
 * Minimal RTF: colour and font tables and \\cfN / \\fN / \\fsN runs only. No
 * paragraph marks, so the receiving document keeps its own paragraph.
 */
export function buildRtf(rich: RichText): string {
	const colors: string[] = [];
	const fonts: string[] = [];
	const indexOf = (list: string[], key: string) => {
		const i = list.indexOf(key);
		return i >= 0 ? i : list.push(key) - 1;
	};
	const body = rich
		.map((run) => {
			const text = rtfEscape(run.text);
			let props = "";
			if (run.font) props += `\\f${indexOf(fonts, checkFont(run.font))}`;
			if (run.sizePt !== undefined) props += `\\fs${checkSize(run.sizePt) * 2}`;
			if (run.color) props += `\\cf${indexOf(colors, run.color.toUpperCase()) + 1}`;
			return props ? `{${props} ${text}}` : text;
		})
		.join("");
	const fontTable = fonts.length ? `{\\fonttbl${fonts.map((f, i) => `{\\f${i}\\fnil ${rtfEscape(f)};}`).join("")}}` : "";
	const colorTable = colors.length
		? `{\\colortbl ;${colors
				.map((c) => {
					const [r, g, b] = parseColor(c);
					return `\\red${r}\\green${g}\\blue${b};`;
				})
				.join("")}}`
		: "";
	return `{\\rtf1\\ansi\\uc1${fontTable}${colorTable}${body}}`;
}

export function buildClipboardPayload(rich: RichText, formats: PasteFormats = "auto"): ClipboardPayload {
	const payload: ClipboardPayload = { text: plainText(rich) };
	if (formats === "auto" || formats === "html") payload.html = buildCfHtml(htmlFragment(rich));
	if (formats === "auto" || formats === "rtf") payload.rtf = buildRtf(rich);
	return payload;
}

export function isPasteFormats(value: unknown): value is PasteFormats {
	return value === "auto" || value === "html" || value === "rtf" || value === "text";
}
