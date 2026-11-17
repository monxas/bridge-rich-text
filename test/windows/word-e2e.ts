// End-to-end test against the real Microsoft Word for Windows.
//
//   npm run test:word:win
//
// Drives the real helper through the real plugin client, like the actions
// do: for each clipboard mode and document font it opens a new Word document,
// types "x ", presses a suit (pasteRequestFor) and a captured snippet
// (snippetRequestFor, the real Word capture in test/fixtures), each after a
// probe(), and types "AKQ" after each paste like a user. The document is saved
// as .docx and the runs in word/document.xml are checked.
//
// Word is driven through its COM object model (test/windows/word.ps1) and
// brought to the front while it runs: don't type or copy during the test.
// If Word is not running, the first check starts it like a user would and
// presses once right away (the KB 238610 case: Office registers in the
// Running Object Table only once its window has lost the focus).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snippetFromCapture } from "../../src/capture";
import { type InsertionFormat, PasteHelper } from "../../src/paste-helper";
import type { PasteFormats } from "../../src/richtext";
import { type SnippetRun, type SnippetSettings, snippetRequestFor } from "../../src/snippet";
import { pasteRequestFor } from "../../src/suit-payload";
import { BRIDGE_SUITS } from "../../src/suits";

const helperPath = path.resolve("com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper.exe");
const wordPs1 = path.resolve("test/windows/word.ps1");
const work = mkdtempSync(path.join(tmpdir(), "bridge-word-e2e-"));
const SUIT = "clubs" as const;
const SUIT_SYMBOL = BRIDGE_SUITS[SUIT].symbol;
const SUIT_CHARS = /[♠♥♦♣]/u;

/** Runs PowerShell with test/windows/word.ps1 loaded and $w = the running Word (when one is). */
function ps(body: string): string {
	const script = `. '${wordPs1}'; $w = Get-Word; ${body}`;
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setClipboard = (text: string) => ps(`Set-Clipboard -Value '${text}'`);
const getClipboard = () => ps(`Get-Clipboard -Raw`);

// The snippet: what the real Word for Windows put on the clipboard for
// red bold ♥, " 1NT " and ♥♠ from Insert > Symbol (see capture.test.ts).
const capturedRtf = readFileSync("test/fixtures/word-win-capture.rtf", "latin1");
const snippet = snippetFromCapture({ rtf: capturedRtf })!.runs as SnippetRun[];
const snippetText = snippet.map((r) => r.text).join("");

interface Run {
	text: string;
	color?: string;
	font?: string;
	size: number;
	bold: boolean;
}

function docxRuns(docx: string): Run[] {
	const out = path.join(work, "x");
	rmSync(out, { recursive: true, force: true });
	ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${docx}', '${out}')`);
	const xml = readFileSync(path.join(out, "word/document.xml"), "utf8");
	const styles = readFileSync(path.join(out, "word/styles.xml"), "utf8");
	const defaultSize = Number(/<w:docDefaults>.*?<w:sz w:val="(\d+)"/s.exec(styles)?.[1] ?? 24) / 2;
	const result: Run[] = [];
	for (const m of xml.matchAll(/<w:r(?: [^>]*)?>(?:<w:rPr>(.*?)<\/w:rPr>)?(?:(?!<\/w:r>).)*?<w:t(?: [^>]*)?>(.*?)<\/w:t><\/w:r>/gs)) {
		const props = m[1] ?? "";
		result.push({
			text: m[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
			color: /<w:color w:val="([0-9A-Fa-f]{6}|auto)"/.exec(props)?.[1]?.toUpperCase(),
			font: /<w:rFonts [^>]*w:ascii="([^"]+)"/.exec(props)?.[1] ?? /<w:rFonts [^>]*w:hAnsi="([^"]+)"/.exec(props)?.[1],
			size: Number(/<w:sz w:val="(\d+)"/.exec(props)?.[1] ?? NaN) / 2 || defaultSize,
			bold: /<w:b(?: w:val="(?:1|true|on)")?\/>/.test(props),
		});
	}
	return result;
}

const log = {
	info: () => {},
	warn: (m: unknown) => console.log(`    helper: ${m}`),
	error: (m: unknown) => console.log(`    helper: ${m}`),
};

/** KB 238610: press once right after a user-style start of Word. */
async function firstPress(): Promise<string> {
	if (ps(`if ($w) { 'running' } elseif (Get-Process WINWORD -ErrorAction SilentlyContinue) { 'process' } else { 'none' }`) !== "none")
		return "skipped (Word was already running)";
	spawn("cmd.exe", ["/c", "start", "", "winword.exe", "/w", "/q"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
	for (let i = 0; i < 60 && ps(`[BridgeFg]::ForegroundClass()`) !== "OpusApp"; i++) await sleep(500);
	await sleep(1500);
	const helper = new PasteHelper(helperPath, log);
	const first = await helper.probe();
	const rotFirst = ps(`if ($w) { 'yes' } else { 'no' }`);
	// The KB's workaround: let Word lose the focus once (to the desktop), then give it back.
	ps(`$s = New-Object -ComObject Shell.Application; $s.MinimizeAll(); Start-Sleep -Milliseconds 700; $s.UndoMinimizeALL(); Start-Sleep -Milliseconds 700`);
	const rotAfter = ps(`if ($w) { Show-Word $w | Out-Null; 'yes' } else { 'no' }`);
	await sleep(500);
	const second = await helper.probe();
	helper.dispose();
	const fmt = (f: InsertionFormat) => (f.font || f.docFont ? `${f.docFont}/${f.font} ${f.sizePt}pt` : "empty");
	return `first press probe ${fmt(first)}, in ROT ${rotFirst}; after a focus change probe ${fmt(second)}, in ROT ${rotAfter}`;
}

/** wdKeepSourceFormatting 0, wdMatchDestinationFormatting 1 (Merge Formatting), wdKeepTextOnly 2. */
type PasteOption = 0 | 1 | 2;

async function variant(
	name: string,
	formats: PasteFormats,
	docFont: string,
	docSize: number,
	keep: Partial<SnippetSettings> = {},
	pasteOption: PasteOption = 1,
) {
	const file = path.join(work, `bridge-e2e-${name}.docx`);
	rmSync(file, { force: true });
	const fg = ps(`if (-not $w) { $w = New-Object -ComObject Word.Application }
$d = $w.Documents.Add()
$s = $w.Selection
$s.Font.Name = '${docFont}'; $s.Font.Size = ${docSize}
$s.TypeText('x ')
Show-Word $w`);
	if (fg !== "OpusApp") {
		ps(`$w.ActiveDocument.Close(0)`);
		console.log(`FAIL ${name}: Word is not in the foreground (${fg})`);
		return false;
	}
	await sleep(400);

	// Word's "Pasting from other programs" option: the helper must override it
	// for its own paste only (Merge Formatting drops the colour) and put it back.
	ps(`$w.Options.PasteFormatFromExternalSource = ${pasteOption}`);
	setClipboard("ORIGINAL CLIPBOARD");
	const helper = new PasteHelper(helperPath, log);
	const notes: string[] = [];
	const press = async (request: (f: InsertionFormat) => Parameters<PasteHelper["paste"]>[0]) => {
		const fg = ps(`Show-Word $w`);
		if (fg !== "OpusApp") throw new Error(`Word is not in the foreground (${fg})`);
		const format = await helper.probe();
		notes.push(`probe font=${format.font} doc=${format.docFont} size=${format.sizePt}`);
		notes.push(await helper.paste(request(format)));
		await sleep(300);
		ps(`$w.Selection.TypeText('AKQ')`);
		return format;
	};
	let suitProbe: InsertionFormat, snippetProbe: InsertionFormat;
	try {
		suitProbe = await press((f) => pasteRequestFor({ suit: SUIT, formats }, f));
		ps(`$w.Selection.TypeText(' ')`);
		snippetProbe = await press((f) => snippetRequestFor({ snippet, formats, ...keep }, f)!);
	} catch (err) {
		helper.dispose();
		ps(`$w.ActiveDocument.Close(0)`);
		console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
	helper.dispose();
	await sleep(500);
	const clipboardAfter = getClipboard();
	const optionAfter = ps(`$w.Options.PasteFormatFromExternalSource`);

	ps(`$w.ActiveDocument.SaveAs2('${file}', 16); $w.ActiveDocument.Close(0)`);
	const chars = docxRuns(file).flatMap((run) => [...run.text].map((ch) => ({ ch, run })));
	const failures: string[] = [];
	const check = (ok: boolean, what: string) => {
		if (!ok) failures.push(what);
	};
	const text = chars.map((c) => c.ch).join("");
	const expected = `x ${SUIT_SYMBOL}AKQ ${snippetText}AKQ`;
	check(text === expected, `document text is "${text}" (expected "${expected}")`);
	check(!text.includes("️"), "document has U+FE0F");
	const noColour = (c?: string) => c === undefined || c === "AUTO" || c === "000000";
	// Word may draw ♠♥♦♣ in Segoe UI Symbol itself (its own font association, e.g.
	// for Aptos, a cloud font the probe cannot inspect): fine, it is a text font.
	const suitFontOk = (got: string | undefined, want: string | undefined) => got === want || got === "Segoe UI Symbol";
	// Known Word limitation, only when the key is set to HTML only: Word's HTML
	// import takes Times New Roman 12 pt (the HTML defaults) as "no formatting"
	// and applies the Normal style's font and size. "auto" sends RTF to Word.
	const htmlDefaults = formats === "html" && docFont === "Times New Roman" && docSize === 12;
	if (htmlDefaults) notes.push("known: Word's HTML import drops Times New Roman 12pt (font/size not checked)");

	// The suit.
	const s = chars.findIndex((c) => c.ch === SUIT_SYMBOL);
	if (s < 0) failures.push("suit missing");
	else {
		const { run } = chars[s];
		check(run.color === BRIDGE_SUITS[SUIT].color.slice(1), `suit colour ${run.color} (expected ${BRIDGE_SUITS[SUIT].color.slice(1)})`);
		check(suitFontOk(run.font, suitProbe.font), `suit font ${run.font} (expected the probe's ${suitProbe.font})`);
		if (!htmlDefaults) check(run.size === docSize, `suit size ${run.size} (expected ${docSize})`);
	}

	// The snippet, character by character.
	const start = text.indexOf(snippetText, s + 1);
	if (start < 0) failures.push("snippet missing");
	else {
		const want = snippet.flatMap((r) => [...r.text].map((ch) => ({ ch, r })));
		want.forEach(({ ch, r }, i) => {
			const got = chars[start + i]?.run;
			if (!got || ch === " ") return;
			const font = keep.keepFont ? r.font : SUIT_CHARS.test(ch) ? snippetProbe.font : snippetProbe.docFont;
			const size = keep.keepSize ? r.sizePt : docSize;
			const colour = r.color?.slice(1);
			check(colour === "000000" ? noColour(got.color) : got.color === colour, `snippet "${ch}" colour ${got.color} (expected ${colour})`);
			if (font && !htmlDefaults)
				check(SUIT_CHARS.test(ch) && !keep.keepFont ? suitFontOk(got.font, font) : got.font === font, `snippet "${ch}" font ${got.font} (expected ${font})`);
			if (!htmlDefaults) check(got.size === size, `snippet "${ch}" size ${got.size} (expected ${size})`);
			check(got.bold === !!r.bold, `snippet "${ch}" bold ${got.bold} (expected ${!!r.bold})`);
		});
	}

	// What the user types after each paste.
	for (const at of [text.indexOf("AKQ"), text.lastIndexOf("AKQ")]) {
		for (const { ch, run } of chars.slice(at, at + 3)) {
			check(noColour(run.color), `typed "${ch}" coloured ${run.color}`);
			check(run.font === docFont && run.size === docSize, `typed "${ch}" is ${run.font} ${run.size}pt (expected ${docFont} ${docSize}pt)`);
			check(!run.bold, `typed "${ch}" is bold`);
		}
	}
	check(clipboardAfter === "ORIGINAL CLIPBOARD", `clipboard after = "${clipboardAfter}"`);
	check(optionAfter === String(pasteOption), `Word's PasteFormatFromExternalSource after = ${optionAfter} (expected ${pasteOption})`);

	const fonts = [...new Set(chars.filter((c) => c.ch !== " ").map((c) => `${c.ch}:${c.run.font ?? "(style)"}`))].join(" ");
	console.log(`${failures.length ? "FAIL" : "ok  "} ${name.padEnd(22)} ${fonts}`);
	for (const n of [...new Set(notes.filter(Boolean))]) console.log(`    note: ${n}`);
	for (const f of failures) console.log(`    - ${f}`);
	return failures.length === 0;
}

const startedWord = ps(`if ($w -or (Get-Process WINWORD -ErrorAction SilentlyContinue)) { 'no' } else { 'yes' }`) === "yes";
console.log(`KB 238610: ${await firstPress()}`);
const userPasteOption = ps(`$w.Options.PasteFormatFromExternalSource`);
const results: boolean[] = [];
const fonts: [string, number][] = [["Calibri", 11], ["Aptos", 11], ["Times New Roman", 12], ["Arial", 14]];
try {
	for (const formats of ["auto", "rtf", "html"] as PasteFormats[])
		for (const [font, size] of fonts) results.push(await variant(`${formats}-${font.replace(/ /g, "")}${size}`, formats, font, size));
	results.push(await variant("auto-Arial14-keepfontsize", "auto", "Arial", 14, { keepFont: true, keepSize: true }));
	results.push(await variant("auto-Calibri11-keepsource", "auto", "Calibri", 11, {}, 0));
	results.push(await variant("auto-Calibri11-textonly", "auto", "Calibri", 11, {}, 2));
} finally {
	ps(`$w.Options.PasteFormatFromExternalSource = ${userPasteOption}`);
}

if (startedWord) ps(`if ($w -and $w.Documents.Count -le 1) { foreach ($d in @($w.Documents)) { $d.Close(0) }; $w.Quit() }`);
rmSync(work, { recursive: true, force: true });
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
