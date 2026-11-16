// End-to-end test against the real Microsoft Word for Mac.
//
//   npm run test:word:mac
//
// Drives the real helper through the real plugin client: for each clipboard
// mode it opens a new Word document in Arial 14 pt, presses the four suits
// (real Cmd+V via the helper), types "AKQ " after each one like a user, saves
// the document as .docx and inspects the runs in word/document.xml.
//
// Needs: macOS, Word, and Accessibility permission for the app running this
// script (Terminal / iTerm). Word is brought to the front while it runs:
// don't type during the test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PasteHelper } from "../../src/paste-helper";
import type { PasteFormats } from "../../src/richtext";
import { pasteRequestFor } from "../../src/suit-payload";
import { BRIDGE_SUITS, type BridgeSuit } from "../../src/suits";

const helperPath = path.resolve("com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper-macos");
// Word is sandboxed: saving inside its own container needs no file-access prompt.
const saveDir = path.join(homedir(), "Library/Containers/com.microsoft.Word/Data/Documents");
const suits: BridgeSuit[] = ["spades", "hearts", "diamonds", "clubs"];

const osa = (script: string) => execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
const word = (body: string) => osa(`with timeout of 30 seconds\ntell application "Microsoft Word"\n${body}\nend tell\nend timeout`);
const setClipboard = (text: string) => execFileSync("pbcopy", { input: text });
const getClipboard = () => execFileSync("pbpaste", { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
	text: string;
	color?: string;
	font?: string;
	size?: number;
}

function runs(docx: string): Run[] {
	const dir = mkdtempSync(path.join(tmpdir(), "bridge-docx-"));
	try {
		const xml = execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8", cwd: dir });
		const styles = execFileSync("unzip", ["-p", docx, "word/styles.xml"], { encoding: "utf8", cwd: dir });
		// Runs without <w:sz> use the document default size.
		const defaultSize = Number(/<w:docDefaults>.*?<w:sz w:val="(\d+)"/s.exec(styles)?.[1] ?? 24) / 2;
		const result: Run[] = [];
		for (const m of xml.matchAll(/<w:r(?: [^>]*)?>(?:<w:rPr>(.*?)<\/w:rPr>)?(?:(?!<\/w:r>).)*?<w:t(?: [^>]*)?>(.*?)<\/w:t><\/w:r>/gs)) {
			const props = m[1] ?? "";
			result.push({
				text: m[2],
				color: /<w:color w:val="([0-9A-Fa-f]{6}|auto)"/.exec(props)?.[1]?.toUpperCase(),
				font: /<w:rFonts w:ascii="([^"]+)"/.exec(props)?.[1] ?? /<w:rFonts [^>]*w:hAnsi="([^"]+)"/.exec(props)?.[1],
				size: Number(/<w:sz w:val="(\d+)"/.exec(props)?.[1] ?? NaN) / 2 || defaultSize,
			});
		}
		return result;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Characters of the paragraph with the formatting of the run each one is in. */
function charFormats(all: Run[]): { ch: string; run: Run }[] {
	return all.flatMap((run) => [...run.text].map((ch) => ({ ch, run })));
}

async function variant(name: string, formats: PasteFormats, resetWordFormatting: boolean, docFont = "Arial", docSize = 14) {
	const file = path.join(saveDir, `bridge-e2e-${name}.docx`);
	rmSync(file, { force: true });
	word(`activate
set d to make new document
set content of text object of d to "Contract: "
set name of font object of text object of d to "${docFont}"
set font size of font object of text object of d to ${docSize}
end key (selection) move unit a story`);
	await sleep(800);

	setClipboard("ORIGINAL CLIPBOARD");
	const log = { info: () => {}, warn: (m: unknown) => console.log(`    helper: ${m}`), error: (m: unknown) => console.log(`    helper: ${m}`) };
	const helper = new PasteHelper(helperPath, log);
	const notes: string[] = [];
	for (const suit of suits) {
		const format = await helper.probe();
		notes.push(`probe ${format.font} ${format.sizePt}`);
		notes.push(await helper.paste(pasteRequestFor({ suit, formats, resetWordFormatting }, format)));
		word(`type text selection text "AKQ "`);
	}
	helper.dispose();
	await sleep(500);
	const clipboardAfter = getClipboard();

	word(`save as active document file name "${file}" file format format document
close active document saving no`);

	const chars = charFormats(runs(file));
	const failures: string[] = [];
	const check = (ok: boolean, what: string) => {
		if (!ok) failures.push(what);
	};
	const text = chars.map((c) => c.ch).join("");
	check(text === "Contract: ♠AKQ ♥AKQ ♦AKQ ♣AKQ ", `document text is "${text}"`);
	for (const suit of suits) {
		const { symbol, color } = BRIDGE_SUITS[suit];
		const c = chars.find((x) => x.ch === symbol);
		if (!c) {
			failures.push(`${suit} missing`);
			continue;
		}
		const expectedColor = formats === "text" ? undefined : color.slice(1).toUpperCase();
		check(c.run.color === expectedColor, `${suit} colour ${c.run.color ?? "none"} (expected ${expectedColor ?? "none"})`);
		const rich = formats !== "text";
		if (rich) {
			// The document font, or the text fallback when it has no suit glyphs — never the emoji font.
			check(c.run.font === docFont || c.run.font === "Arial", `${suit} font ${c.run.font} (expected ${docFont} or Arial)`);
			check(c.run.size === docSize, `${suit} size ${c.run.size}pt (expected ${docSize})`);
		}
		const after = chars[chars.indexOf(c) + 1];
		const typedColoured = after.run.color !== undefined && after.run.color !== "AUTO" && after.run.color !== "000000";
		if (resetWordFormatting) check(!typedColoured, `text typed after ${suit} is coloured ${after.run.color}`);
		check(after.run.font === docFont && after.run.size === docSize, `text typed after ${suit} is ${after.run.font} ${after.run.size}pt`);
	}
	check(clipboardAfter === "ORIGINAL CLIPBOARD", `clipboard after = "${clipboardAfter}"`);

	const fonts = [...new Set(chars.filter((c) => c.ch !== " ").map((c) => `${c.ch}:${c.run.font ?? "(style)"}`))].join(" ");
	console.log(`${failures.length ? "FAIL" : "ok  "} ${name.padEnd(14)} fonts ${fonts}`);
	for (const n of [...new Set(notes.filter(Boolean))]) console.log(`    note: ${n}`);
	for (const f of failures) console.log(`    - ${f}`);
	return failures.length === 0;
}

const results = [
	await variant("auto", "auto", true),
	await variant("auto-aptos11", "auto", true, "Aptos", 11),
	await variant("auto-times10", "auto", true, "Times New Roman", 10.5),
	await variant("auto-calibri12", "auto", true, "Calibri", 12),
	await variant("auto-noreset", "auto", false),
	await variant("rtf", "rtf", true),
	await variant("html", "html", true),
	await variant("text", "text", true),
];
process.exit(results.every(Boolean) ? 0 : 1);
