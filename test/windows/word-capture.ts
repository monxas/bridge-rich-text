// Capture test against the real Microsoft Word for Windows.
//
//   npx tsx test/windows/word-capture.ts [--save]
//
// Builds a small formatted paragraph in a new Word document through COM
// (red bold ♥ in Calibri 11, " 1NT" black, a Symbol-font ♠ from
// Insert > Symbol), copies it with Word's own Copy, then asks the real helper
// for a capture and parses it with snippetFromCapture(). With --save, the
// raw RTF is written to test/fixtures/word-win-capture.rtf.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snippetFromCapture } from "../../src/capture";
import { PasteHelper } from "../../src/paste-helper";

const helperPath = path.resolve("com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper.exe");

const ps = (script: string) =>
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();

// Word keeps the document open (delayed clipboard rendering needs Word alive).
ps(`
$w = New-Object -ComObject Word.Application
$w.Visible = $true
$d = $w.Documents.Add()
$s = $w.Selection
$s.Font.Name = "Calibri"; $s.Font.Size = 11
$s.Font.Color = 255; $s.Font.Bold = $true            # wdColor is BGR: 255 = red
$s.TypeText([string][char]0x2665)
$s.Font.Name = "Calibri"; $s.Font.Color = 0; $s.Font.Bold = $false   # Word switched to Segoe UI Symbol for the heart
$s.TypeText(" 1NT ")
$s.InsertSymbol(-3927, "Symbol", $true)               # U+F0A9 in Symbol = heart
$s.InsertSymbol(-3926, "Symbol", $true)               # U+F0AA in Symbol = spade
$d.Content.Select()
$w.Selection.MoveEnd(1, -1) | Out-Null                # leave the paragraph mark out
$w.Selection.Copy()
`);

const log = { info: () => {}, warn: (m: unknown) => console.log(`helper: ${m}`), error: (m: unknown) => console.log(`helper: ${m}`) };
const helper = new PasteHelper(helperPath, log);
const captured = await helper.capture();
helper.dispose();

console.log("formats:", Object.keys(captured).join(", "));
console.log("text:", JSON.stringify(captured.text));
const result = snippetFromCapture(captured);
console.log("source:", result?.source);
console.log(JSON.stringify(result?.runs, null, 2));

if (process.argv.includes("--save") && captured.rtf) {
	mkdirSync("test/fixtures", { recursive: true });
	writeFileSync("test/fixtures/word-win-capture.rtf", captured.rtf, "latin1");
	if (captured.html) writeFileSync("test/fixtures/word-win-capture.html", captured.html, "utf8");
	console.log("saved test/fixtures/word-win-capture.rtf");
}

ps(`$w = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application"); $w.ActiveDocument.Close(0); if ($w.Documents.Count -eq 0) { $w.Quit() }`);
