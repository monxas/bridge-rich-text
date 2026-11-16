import { describe, expect, it } from "vitest";
import { buildCfHtml, buildClipboardPayload, buildRtf, htmlFragment } from "../src/richtext";

/** Parses a CF_HTML string the way a Windows consumer does: byte offsets into UTF-8. */
function parseCfHtml(cf: string) {
	const bytes = Buffer.from(cf, "utf8");
	const header = (name: string) => Number(new RegExp(`${name}:(\\d+)`).exec(cf)![1]);
	const startHtml = header("StartHTML");
	const endHtml = header("EndHTML");
	const startFragment = header("StartFragment");
	const endFragment = header("EndFragment");
	return {
		startHtml,
		endHtml,
		html: bytes.subarray(startHtml, endHtml).toString("utf8"),
		fragment: bytes.subarray(startFragment, endFragment).toString("utf8"),
		total: bytes.length,
	};
}

describe("CF_HTML", () => {
	it.each([
		["ascii", "<b>x</b>"],
		["suit", '<span style="color:#DC0000">♥</span>'],
		["multibyte mix", "é♠€😀"],
	])("offsets are exact UTF-8 byte offsets (%s)", (_, fragment) => {
		const cf = buildCfHtml(fragment);
		const parsed = parseCfHtml(cf);
		expect(parsed.fragment).toBe(fragment);
		expect(parsed.endHtml).toBe(parsed.total);
		expect(parsed.html.startsWith("<html>")).toBe(true);
		expect(parsed.html.endsWith("</html>")).toBe(true);
		expect(parsed.html).toContain(`<!--StartFragment-->${fragment}<!--EndFragment-->`);
	});

	it("has a spec-conformant header with 10-digit offsets", () => {
		const cf = buildCfHtml("x");
		expect(cf).toMatch(/^Version:0\.9\r\nStartHTML:\d{10}\r\nEndHTML:\d{10}\r\nStartFragment:\d{10}\r\nEndFragment:\d{10}\r\n<html>/);
	});

	it("only sets the foreground colour", () => {
		expect(htmlFragment([{ text: "♥", color: "#dc0000" }])).toBe('<span style="color:#DC0000">♥</span>');
	});

	it("rejects font names that could inject CSS or RTF", () => {
		expect(() => htmlFragment([{ text: "x", font: "Arial';color:red" }])).toThrow();
		expect(() => buildRtf([{ text: "x", font: "A}{\\b" }])).toThrow();
		expect(() => htmlFragment([{ text: "x", sizePt: 0 }])).toThrow();
	});

	it("escapes text and rejects non-hex colours", () => {
		expect(htmlFragment([{ text: "<a&b>" }])).toBe("&#60;a&#38;b&#62;");
		expect(() => htmlFragment([{ text: "x", color: "red;font-size:40pt" }])).toThrow();
	});
});

describe("RTF", () => {
	it("encodes a coloured suit with a colour table and no font or paragraph", () => {
		expect(buildRtf([{ text: "♥", color: "#DC0000" }])).toBe("{\\rtf1\\ansi\\uc1{\\colortbl ;\\red220\\green0\\blue0;}{\\cf1 \\u9829?}}");
	});

	it("reuses colour table entries and escapes control characters", () => {
		const rtf = buildRtf([
			{ text: "♥", color: "#DC0000" },
			{ text: "{a}\\" },
			{ text: "♦", color: "#dc0000" },
		]);
		expect(rtf).toBe("{\\rtf1\\ansi\\uc1{\\colortbl ;\\red220\\green0\\blue0;}{\\cf1 \\u9829?}\\{a\\}\\\\{\\cf1 \\u9830?}}");
		expect(rtf).not.toMatch(/\\par|\\f\d|\\fs\d/);
	});

	it("writes code units above 0x7FFF as signed 16-bit values", () => {
		expect(buildRtf([{ text: "😀" }])).toBe("{\\rtf1\\ansi\\uc1\\u-10179?\\u-8704?}");
	});
});

describe("payload formats", () => {
	const rich = [{ text: "♣", color: "#008A35" }];
	it.each([
		["auto", true, true],
		["html", true, false],
		["rtf", false, true],
		["text", false, false],
	] as const)("%s", (formats, html, rtf) => {
		const p = buildClipboardPayload(rich, formats);
		expect(p.text).toBe("♣");
		expect(p.html !== undefined).toBe(html);
		expect(p.rtf !== undefined).toBe(rtf);
	});
});
