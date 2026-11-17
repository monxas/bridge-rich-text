# Windows test: captured text (for the agent on Mon's Windows PC)

Context: the plugin gained a second action, **Insert Captured Text**
(`com.monxas.bridgesuits.snippet`). The user copies something in Word, presses
*Capture clipboard* in the key's property inspector, and the key then pastes
that text with its colour (and optionally font, size, bold/italic). It was
built and unit-tested on macOS; the Windows side (helper `capture` command,
Word COM probe with the new `doc=` field, paste into real Word) has **never
run on real Windows**. Your job is to prove or fix it there.

Read first: `README.md`, `src/capture.ts`, `src/snippet.ts`,
`src/actions/insert-snippet.ts`, `native/bridge-paste-helper.c`
(`answer_capture`, `probe_note`), `test/macos/word-e2e.ts` (the macOS
equivalent of what you will write).

## 0. Setup

```powershell
git clone https://github.com/monxas/bridge-rich-text C:\dev\bridge-rich-text
cd C:\dev\bridge-rich-text
npm ci
npm test            # must pass as on macOS
npm run build
```

The helper `.exe` is committed prebuilt. To rebuild it on Windows you need
MinGW-w64 (MSYS2, see README *Build*); only do that if you change the C code.

## 1. Helper `capture` against real Word

1. In Word, type a few characters and format them: e.g. `♥` red bold in
   Calibri 11, then ` 1NT` black; also insert a suit with *Insert > Symbol*
   using the **Symbol** font. Select and copy (Ctrl+C).
2. Drive the helper by hand (`bridge-paste-helper.exe` reads lines on stdin,
   see the protocol comment in `src/paste-helper.ts`), or from a small tsx
   script using `PasteHelper.capture()`, then `snippetFromCapture()`.
3. Expect `source: "rtf"`, the right text, colours `#RRGGBB`, font names,
   sizes, bold/italic. Save the raw RTF as `test/fixtures/word-win-*.rtf`
   and add a unit test that parses it, so real Word output is covered.
4. Also capture from a browser (Edge/Chrome copy of coloured text: HTML, no
   RTF) and from Notepad (plain text: `source: "text"`).

## 2. End-to-end paste into Word (write `test/windows/word-e2e.ts`)

Mirror `test/macos/word-e2e.ts`, using Word's COM object model through
PowerShell (`New-Object -ComObject Word.Application` or
`[Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")`)
instead of AppleScript, and `npm run test:word:win` in `package.json`.

For each clipboard mode (`auto`, `rtf`, `html`) and document fonts
(Calibri 11, Aptos 11, Times New Roman 12, Arial 14):

- new document, type `x ` in that font;
- paste a **suit** (existing action, `pasteRequestFor`) and a **snippet**
  (`snippetRequestFor` with default keep options) through the real helper
  (`PasteHelper.paste`, after `probe()` like the actions do);
- type `AKQ` after each paste (SendKeys or COM `Selection.TypeText`);
- save `.docx`, inspect `word/document.xml` runs.

Pass criteria:

- suit and snippet text exact, plain Unicode (no U+FE0F), colour exact;
- default keep options: snippet in the document's font and size (suits in a
  glyph-safe fallback when the document font has no ♠♥♦♣: Segoe UI Symbol);
  with *keep font/size* on, the captured font/size;
- `AKQ` typed after the paste has the document font/size and no colour;
- the clipboard content from before the test is restored afterwards;
- also the Word COM KB 238610 caveat: note whether the probe works on the
  first press after Word starts.

## 3. Through Stream Deck (Mon presses the keys)

```powershell
npx streamdeck link com.monxas.bridgesuits.sdPlugin
npx streamdeck restart com.monxas.bridgesuits
```

Ask Mon to: drag *Bridge Suits > Insert Captured Text* onto a key, copy
something coloured in Word, press *Capture clipboard*, check the preview and
the key image, then press the key in a Word document. Read
`com.monxas.bridgesuits.sdPlugin/logs/com.monxas.bridgesuits.0.log` for
`captured ... from rtf` and `inserted snippet ...`.

## Reporting

Commit fixes and new tests straight to `main` (no branches), with what ran
and what passed in the commit message. Update README's *Tests* table rows for
Windows. Leave the board card (`tablero`) with Hecho / Siguiente / Cómo
comprobar.
