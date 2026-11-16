# Bridge Suits — Stream Deck plugin

Inserts the four bridge suit symbols into Microsoft Word (or any rich-text editor) as **coloured, editable Unicode text**:

| Key | Character | Colour |
|---|---|---|
| Spades | ♠ U+2660 | `#111111` |
| Hearts | ♥ U+2665 | `#DC0000` |
| Diamonds | ♦ U+2666 | `#DC0000` |
| Clubs | ♣ U+2663 | `#008A35` |

Windows 10/11 and macOS 12+, Stream Deck 7.1+. No VBA, no Word add-in, no internet access needed, no paid dependencies.

The inserted characters are the plain Unicode code points above (text, never emoji: no U+FE0F) with a font colour. MIT licensed. Design: [docs/ADR-001](docs/ADR-001-stream-deck-bridge-suits.md).

## Install

1. Download **[com.monxas.bridgesuits.streamDeckPlugin](https://github.com/monxas/bridge-rich-text/releases/latest/download/com.monxas.bridgesuits.streamDeckPlugin)** (latest release), or build it (see *Build*).
2. Double-click it. Stream Deck installs it.
3. In Stream Deck, drag **Bridge Suits → Insert Bridge Suit** onto four keys and choose a suit for each one in the property inspector.
4. Click into a Word document and press a key.

Nothing else needs installing: the plugin runs on the Node.js runtime that ships with Stream Deck. The native helper is a 28 KB executable that only uses DLLs built into Windows 10/11, or a universal (Apple silicon + Intel) binary on macOS.

**macOS permissions** (asked on first use):
- *Accessibility* for **Stream Deck** (System Settings → Privacy & Security → Accessibility), needed to send ⌘V. Without it the key shows ⚠ and the log says `accessibility_denied`.
- *Automation → Microsoft Word* for Stream Deck, used to read the font/size at the cursor and to give the text typed next its previous formatting. If refused, suits are still inserted in colour, but without font matching.

### Property inspector

| Setting | Default | Purpose |
|---|---|---|
| Suit | Spades | The symbol this key inserts. |
| Clipboard | HTML + RTF | Which rich formats are offered to the target. Change to *RTF only* or *HTML only* if Word applies an unwanted font; *Plain text* is a diagnostic mode without colour. |
| Word: use the font and size at the cursor | on | Asks Word for the font and size at the insertion point (macOS: Apple Events; Windows: Word's COM object model — no VBA, nothing installed in Word) and inserts the suit in them. If that font has no ♠♥♦♣ glyphs (Aptos, Calibri…), a text font that has them is used (macOS: Arial; Windows: Segoe UI Symbol), because otherwise Word for Mac draws them with *Apple Color Emoji*, which ignores the colour. |
| Word: keep the text typed next uncoloured | on | After the paste, Word's insertion point gets its previous font, size and colour back through the same interface. Only if that fails (macOS without the Automation permission; Windows when Word is not reachable over COM) it sends `Ctrl+Space`, which resets the insertion point to the paragraph style, so manual formatting such as bold or a manually chosen font is not carried into the next characters. |

## How it works

```text
key press ─▶ plugin (TypeScript, @elgato/streamdeck 3)
              │ builds CF_UNICODETEXT + CF_HTML + RTF       src/richtext.ts
              ▼ one line on stdin
           bridge-paste-helper.exe (C, persistent, no console, no window focus)
              1. waits until no Shift/Ctrl/Alt/Win key is physically held (max 1 s)
              2. snapshots the clipboard (every format it can copy safely)
              3. offers the three formats with *delayed rendering*
              4. SendInput Ctrl+V (+ Ctrl+Space in Word)
              5. waits until the target has actually read the data
                 (250 ms after the last read, or 2 s timeout)
              6. restores the snapshot, unless someone else changed the clipboard meanwhile
```

Key choices:

- **Delayed rendering** (`SetClipboardData(fmt, NULL)` + `WM_RENDERFORMAT`) tells the helper exactly when Word reads the clipboard, so the original clipboard is restored as soon as it is safe, instead of after a guessed delay. If nothing reads it, the press is reported as `paste_not_observed` and the clipboard is restored anyway.
- **Never overwrite newer content**: if another process takes clipboard ownership after the paste (`WM_DESTROYCLIPBOARD`), the snapshot is discarded and the newer content stays.
- **Rapid presses** are queued in the helper and share one snapshot, so a fast second press can never snapshot the first press's payload.
- **Minimal formatting**: HTML is a single `<span style="color:#RRGGBB">`; RTF has only a colour table and `\cfN`. No font, size or paragraph, so Word keeps the surrounding font where it can.
- **Clipboard history**: the temporary payload carries `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0` and `CanUploadToCloudClipboard=0`, so suits do not pile up in Win+V history; the restored content is marked so it is not added a second time.
- **Key images** are SVG paths (`src/render.ts`), not text glyphs, so the keys never fall back to colour emoji. Spades get a light outline to stay visible on the dark key.
- Suit symbols and colours live only in `src/suits.ts`. Other snippets can reuse the whole pipeline by passing a different `RichText` (list of `{ text, color }` runs) to `buildClipboardPayload`.

### Limitations

- The clipboard cannot be locked atomically across applications. Formats that hold GDI/private handles (`CF_OWNERDISPLAY`, `CF_DSP*`, private and GDI-object ranges) cannot be copied; if any were present they are lost and the plugin logs `restore_partial`. Bitmaps, metafiles, text, HTML, RTF and registered formats (e.g. Office's) are preserved. Delayed-render owners such as Excel lose their "marching ants".
- Windows blocks simulated input into applications running **as administrator** (UIPI) when Stream Deck is not elevated. The helper detects a higher integrity level and reports `target_elevated`.
- If you hold Shift/Ctrl/Alt/Win while pressing the key, the helper waits up to 1 s for the release, then reports `modifier_held` (otherwise Word would receive e.g. `Ctrl+Shift+V`).
- Windows: font matching and the typing-format restore use Word's COM object model (`GetActiveObject("Word.Application")`). This code is compiled and its fallback path is tested under Wine, but it has **not run against a real Word for Windows**. Word only registers for COM after its window has lost focus once (Microsoft KB 238610); until then the helper falls back to inserting without font matching and to `Ctrl+Space`.
- macOS: "auto" offers RTF + text only, because Word for Mac prefers HTML and its HTML import draws suits with Apple Color Emoji in some fonts (Times New Roman) where RTF keeps the font.

## Build

Prerequisites: Node.js 24+ (20.5+ works for building), npm, and for the helper the MinGW-w64 C compiler:

| Host | Install |
|---|---|
| Windows | [MSYS2](https://www.msys2.org/), then `pacman -S mingw-w64-ucrt-x86_64-gcc`; run the build from the MSYS2 UCRT64 shell, or set `CC=gcc` |
| macOS | `brew install mingw-w64` |
| Debian/Ubuntu | `apt install gcc-mingw-w64-x86-64` |

```sh
npm ci
npm run release        # typecheck + unit tests + build helper + bundle + validate + pack
# -> dist/com.monxas.bridgesuits.streamDeckPlugin
```

On macOS `npm run release` also builds the macOS helper (`npm run build:helper:macos`, needs Xcode or the Command Line Tools); the Windows helper can be cross-built anywhere.

Individual steps: `npm run build:helper`, `npm run build:helper:macos`, `npm run build`, `npm run icons` (regenerates `imgs/` from `src/render.ts`), `npm run validate`, `npm run pack`.

The packaged `.exe` is part of the source tree under `com.monxas.bridgesuits.sdPlugin/native/` so that a plugin can be packed without a C compiler; rebuild it with `npm run build:helper` after changing `native/bridge-paste-helper.c`.

## Develop and debug (Windows)

```sh
npm run build:helper && npm run build
npx streamdeck link com.monxas.bridgesuits.sdPlugin   # installs the working folder as a dev plugin
npm run watch                                          # rebuild + restart the plugin on save
```

- Plugin log: `com.monxas.bridgesuits.sdPlugin/logs/com.monxas.bridgesuits.0.log` (each press logs `inserted hearts` or the helper's error code, e.g. `inserting hearts failed: paste_not_observed: ...`). A failed press also shows the yellow ⚠ on the key.
- Node debugger: `Nodejs.Debug` is enabled in the manifest; attach to the Stream Deck plugin process from VS Code / `chrome://inspect`.
- Property inspector: `npx streamdeck dev`, then open `http://localhost:23654/`.
- The helper can be driven by hand: run `bridge-paste-helper.exe` from a console, type a request line (see `src/paste-helper.ts` for the protocol) and switch to Word within the 1 s window.

## Tests

| Level | What | How | Status |
|---|---|---|---|
| Unit (28) | Suit table, CF_HTML byte offsets (incl. multibyte/emoji), RTF encoding, font/size in payloads, font-name injection guards, per-platform formats, key SVGs, helper protocol, client restart/timeout | `npm test` (Vitest, any OS) | automated, passing |
| Windows helper end-to-end (18 checks) | Real `bridge-paste-helper.exe` + a Win32 harness that plays a focused "Word" window (`OpusApp` class) and reads the clipboard on Ctrl+V: HTML/RTF/text received, Ctrl+Space only when enabled, 3 queued presses, original clipboard (text + private format) restored, newer clipboard content left alone, unread paste reported, font probe answered | `npm run test:windows:prepare`, then `test/windows/run-wine.sh dist/windows-test` under Wine on Linux (null graphics driver, no real desktop touched) | automated, passing under Wine 11 (Proton Experimental) |
| **Microsoft Word for Mac** | Real Word, real helper, real ⌘V: four suits per document after text in Arial 14, Aptos 11, Times New Roman 10.5, Calibri 12; then `AKQ` typed after each suit; .docx inspected | `npm run test:word:mac` (Word comes to the front; don't type while it runs) | **passed in Word for Mac** (8/8 variants in one run, 32 real presses): colour exact, suit in document font (Arial, Times) or Arial fallback (Aptos, Calibri), size kept, typed text keeps document font/size and no colour, clipboard restored |
| Microsoft Word for Windows | Same, on Windows | manual, [docs/word-manual-test.md](docs/word-manual-test.md) | **not performed**: no Windows + Word available |

**Word for Windows has not been verified.** The Wine run proves the Windows helper's clipboard and input logic, not how Word for Windows interprets the HTML/RTF. Use the manual checklist; if Word picks an unwanted font, switch *Clipboard* to *RTF only* or *HTML only*.

## Layout

```text
src/suits.ts                     suit symbols + colours (single source)
src/richtext.ts                  RichText → CF_UNICODETEXT / CF_HTML / RTF
src/suit-payload.ts              action settings → paste request
src/render.ts                    key image SVGs
src/paste-helper.ts              persistent helper client + line protocol
src/actions/insert-bridge-suit.ts Stream Deck action
src/plugin.ts                    entry point
native/bridge-paste-helper.c     Windows helper (clipboard + SendInput)
native/macos/BridgePasteHelper.swift  macOS helper (pasteboard + CGEvent + Word Apple Events)
test/                            unit tests; test/windows/ Wine harness; test/macos/ Word for Mac e2e
com.monxas.bridgesuits.sdPlugin/ manifest, property inspector, images, helper .exe
```
