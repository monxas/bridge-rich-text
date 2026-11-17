// Captures whatever is on the clipboard now through the real helper and prints
// what the snippet action would store. Copy something (Notepad, a browser,
// Word...) first.
//
//   npx tsx test/windows/clipboard-capture.ts
import path from "node:path";
import { snippetFromCapture } from "../../src/capture";
import { PasteHelper } from "../../src/paste-helper";

const helperPath = path.resolve("com.monxas.bridgesuits.sdPlugin/native/bridge-paste-helper.exe");
const log = { info: () => {}, warn: (m: unknown) => console.log(`helper: ${m}`), error: (m: unknown) => console.log(`helper: ${m}`) };
const helper = new PasteHelper(helperPath, log);
const captured = await helper.capture();
helper.dispose();
console.log("formats:", Object.keys(captured).join(", ") || "(none)");
const result = snippetFromCapture(captured);
console.log("source:", result?.source ?? "(nothing usable)");
console.log(JSON.stringify(result?.runs, null, 2));
