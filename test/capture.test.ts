import { describe, expect, it } from "vitest";
import { MAX_SNIPPET_LENGTH, parseCssColor, parseHtml, parseRtf, snippetFromCapture } from "../src/capture";
import { parseCaptureNote, parseProbeNote } from "../src/paste-helper";
import { buildRtf } from "../src/richtext";

/** String.raw, except "\U" becomes "\u": the test transform cooks \uXXXX even inside String.raw. */
const R = (s: TemplateStringsArray, ...v: unknown[]) => String.raw(s, ...v).replace(/\\U/g, "\\u");

// Shape of what Word for Windows puts on the clipboard for a red, bold ♥ in
// Calibri 11 (trimmed: the real thing adds ~40 KB of style and theme tables,
// all inside destinations the parser skips).
const WORD_RTF = R`{\rtf1\adeflang1025\ansi\ansicpg1252\uc1\adeff31507\deff0\stshfdbch31505\stshfloch31506
{\fonttbl{\f0\fbidi \froman\fcharset0\fprq2{\*\panose 02020603050405020304}Times New Roman;}{\f37\fbidi \fswiss\fcharset0\fprq2{\*\panose 020f0502020204030204}Calibri;}
{\flomajor\f31500\fbidi \froman\fcharset0\fprq2{\*\panose 02020603050405020304}Times New Roman;}}
{\colortbl;\red0\green0\blue0;\red0\green0\blue255;\caccentone\ctint255\cshade255\red220\green0\blue0;}
{\*\defchp \fs22\loch\af31506\hich\af31506\dbch\af31505 }{\*\defpap \ql \li0\ri0\sa160\sl259\slmult1}
{\stylesheet{\ql \li0\ri0\widctlpar\wrapdefault\aspalpha\aspnum\faauto\adjustright\rin0\lin0\itap0 \rtlch\fcs1 \af31507\afs22 \snext0 \sqformat \spriority0 Normal;}}
{\*\rsidtbl \rsid1590812\rsid7546392}{\mmathPr\mmathFont34\mbrkBin0}
{\info{\author Mon}{\operator Mon}{\creatim\yr2026\mo11\dy17\hr13\min5}}
{\*\xmlnstbl {\xmlns1 http://schemas.microsoft.com/office/word/2003/wordml}}
\paperw12240\paperh15840\margl1440\margr1440\margt1440\margb1440\gutter0\ltrsect
\pard\plain \ltrpar\ql \li0\ri0\sa160\sl259\slmult1\widctlpar\wrapdefault\aspalpha\aspnum\faauto\adjustright\rin0\lin0\itap0\pararsid7546392 \rtlch\fcs1 \af31507\afs22\alang1025 \ltrch\fcs0 \fs22\lang1033\langfe1033\loch\af31506\hich\af31506\dbch\af31505\cgrid\langnp1033\langfenp1033 {\rtlch\fcs1 \ab\af37 \ltrch\fcs0 \b\f37\cf3\insrsid7546392 \U9829\'3f}{\rtlch\fcs1 \af37 \ltrch\fcs0 \f37\insrsid7546392  1NT}
{\*\themedata 504b030414000600080000002100e9de0fbfff0000001c020000130000005b436f6e74656e745f54797065735d2e78}
{\*\colorschememapping 3c3f786d6c2076657273696f6e3d22312e302220656e636f64696e673d225554462d38}
{\*\latentstyleshdr\lsdstimax376\lsdlockeddef0{\lsdlockedexcept \lsdqformat1 \lsdpriority0 \lsdlocked0 Normal;}}
{\*\datastore 01050000020000001800000057006f00720064002e0044006f00630075006d0065006e0074002e00}}`;

describe("parseRtf", () => {
	it("reads Word's clipboard RTF: text, colour, font, size, bold", () => {
		expect(parseRtf(WORD_RTF)).toEqual([
			{ text: "♥", color: "#DC0000", font: "Calibri", sizePt: 11, bold: true, italic: false },
			{ text: " 1NT", color: undefined, font: "Calibri", sizePt: 11, bold: false, italic: false },
		]);
	});

	it("round-trips the plugin's own RTF", () => {
		const rtf = buildRtf([
			{ text: "♠", color: "#111111", font: "Arial", sizePt: 14 },
			{ text: "AKQ", italic: true },
		]);
		const runs = parseRtf(rtf);
		expect(runs.map((r) => r.text).join("")).toBe("♠AKQ");
		expect(runs[0]).toMatchObject({ text: "♠", color: "#111111", font: "Arial", sizePt: 14 });
		expect(runs[1]).toMatchObject({ text: "AKQ", italic: true, color: undefined });
	});

	it("reads macOS Cocoa RTF (\\uc0, font table without groups)", () => {
		const input = R`{\rtf1\ansi\ansicpg1252\cocoartf2820
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fnil\fcharset0 AppleSymbols;}
{\colortbl;\red255\green255\blue255;\red0\green138\blue53;}
{\*\expandedcolortbl;;\cssrgb\c0\c60000\c26667;}
\pard\tx720\pardirnatural\partightenfactor0

\f1\fs28 \cf2 \uc0\U9827
\f0  x}`;
		expect(parseRtf(input)).toEqual([
			{ text: "♣", color: "#008A35", font: "AppleSymbols", sizePt: 14, bold: false, italic: false },
			{ text: " x", color: "#008A35", font: "Helvetica", sizePt: 14, bold: false, italic: false },
		]);
	});

	it("maps suits inserted with Word's Symbol font to Unicode", () => {
		const input = R`{\rtf1\ansi{\fonttbl{\f0 Calibri;}{\f3\fbidi \froman\fcharset2\fprq2 Symbol;}}{\colortbl;\red220\green0\blue0;}{\f3\cf1 \'a9}{\field{\*\fldinst SYMBOL 170 \\f "Symbol"}{\fldrslt{\f3 \U-3926\'aa}}}}`;
		const runs = parseRtf(input);
		expect(runs.map((r) => r.text).join("")).toBe("♥♠");
		expect(runs[0]).toMatchObject({ text: "♥", color: "#DC0000", font: undefined });
	});

	it("handles escapes, surrogate pairs, hidden text and line breaks", () => {
		const input = R`{\rtf1\ansi\uc1 a\{b\}c\\d\~e\'e9{\v hidden}\line \U-10179?\U-8576?\par}`;
		expect(parseRtf(input).map((r) => r.text).join("")).toBe("a{b}c\\d\u00A0eé\n🚀\n");
	});
});

describe("parseHtml", () => {
	it("reads the fragment of a CF_HTML document from a browser", () => {
		const html =
			"Version:0.9\r\nStartHTML:00000097\r\nEndHTML:00000300\r\nStartFragment:00000133\r\nEndFragment:00000264\r\n" +
			'<html><body>\r\n<!--StartFragment--><span style="color: rgb(220, 0, 0); font-family: &quot;Segoe UI&quot;, sans-serif; font-size: 16px;">♥</span>' +
			"<b> AKQ</b><!--EndFragment-->\r\n</body></html>";
		expect(parseHtml(html)).toEqual([
			{ text: "♥", color: "#DC0000", font: "Segoe UI", sizePt: 12 },
			{ text: " AKQ", bold: true },
		]);
	});

	it("reads Word-style HTML with <font>, entities and paragraphs", () => {
		const html = `<html><head><style>p.MsoNormal{font-family:Calibri}</style></head><body>
<p class=MsoNormal><font color="#008A35" face="Arial">&clubs;</font> 2<i>NT</i></p>
<p class=MsoNormal>&#9824;&nbsp;x</p></body></html>`;
		const runs = parseHtml(html);
		expect(runs.map((r) => r.text).join("")).toBe("♣ 2NT\n♠ x");
		expect(runs[0]).toEqual({ text: "♣", color: "#008A35", font: "Arial" });
		expect(runs.find((r) => r.text === "NT")).toMatchObject({ italic: true });
	});

	it("never keeps unsafe font names or colours", () => {
		const runs = parseHtml(`<span style="font-family: 'a<b>'; color: expression(alert(1))">t</span>`);
		expect(runs).toEqual([{ text: "t" }]);
	});

	it("parses CSS colours", () => {
		expect(parseCssColor("#d00")).toBe("#DD0000");
		expect(parseCssColor("RGB(0, 138, 53)")).toBe("#008A35");
		expect(parseCssColor("red")).toBe("#FF0000");
		expect(parseCssColor("currentColor")).toBeUndefined();
	});
});

describe("snippetFromCapture", () => {
	it("prefers RTF, then HTML, then text", () => {
		const html = "<b>B</b>";
		expect(snippetFromCapture({ text: "x", rtf: WORD_RTF, html })?.source).toBe("rtf");
		expect(snippetFromCapture({ text: "x", html })?.source).toBe("html");
		expect(snippetFromCapture({ text: "x\r\n" })).toEqual({ runs: [{ text: "x" }], source: "text" });
		expect(snippetFromCapture({})).toBeUndefined();
		expect(snippetFromCapture({ text: "  \n" })).toBeUndefined();
	});

	it("falls back when RTF has no visible text", () => {
		expect(snippetFromCapture({ rtf: String.raw`{\rtf1{\*\x y}}`, text: "z" })?.source).toBe("text");
	});

	it("trims Word's trailing paragraph mark and limits the length", () => {
		const input = R`{\rtf1\ansi ab\par }`;
		expect(snippetFromCapture({ rtf: input })?.runs.map((r) => r.text)).toEqual(["ab"]);
		const long = snippetFromCapture({ text: "y".repeat(MAX_SNIPPET_LENGTH + 10) });
		expect(long?.runs[0].text.length).toBe(MAX_SNIPPET_LENGTH);
	});
});

describe("helper notes", () => {
	it("decodes a capture answer", () => {
		const b = (s: string, enc: BufferEncoding = "utf8") => Buffer.from(s, enc).toString("base64");
		expect(parseCaptureNote(`text=${b("♥ x")} rtf=${b("{\\rtf1 \\'e9}", "latin1")} html=${b("<b>♥</b>")}`)).toEqual({
			text: "♥ x",
			rtf: "{\\rtf1 \\'e9}",
			html: "<b>♥</b>",
		});
		expect(parseCaptureNote("")).toEqual({});
	});

	it("reads the document font next to the glyph-safe font", () => {
		const b = (s: string) => Buffer.from(s).toString("base64");
		expect(parseProbeNote(`font=${b("Segoe UI Symbol")} doc=${b("Aptos")} size=11`)).toEqual({
			font: "Segoe UI Symbol",
			docFont: "Aptos",
			sizePt: 11,
		});
	});
});
