# Manual integration test — Microsoft Word for Windows

(Word for Mac is covered by the automated `npm run test:word:mac`, which passes.)

Automated tests cannot run Word. Fill this in on a real Windows machine before calling the Word integration verified (ADR-001 §10.10).

**Setup:** Windows ___ build ___ · Word version ___ (File → Account → About) · Stream Deck ___ · plugin 1.0.0.0
Four keys configured: ♠ ♥ ♦ ♣. Default settings (Clipboard: HTML + RTF, reset colour: on) unless a row says otherwise.
Word paste option *File → Options → Advanced → Pasting from other programs*: ___ (default is *Keep Source Formatting*).

| # | Steps | Expected | Result |
|---|---|---|---|
| 1 | New blank document, press ♥ | red ♥ (`#DC0000`); Font Color dropdown shows custom red | |
| 2 | Press ♦ | red ♦ | |
| 3 | Press ♣ | green ♣ (`#008A35`) | |
| 4 | Press ♠ | near-black ♠ (`#111111`) | |
| 5 | Select an inserted ♥, press Shift+F1 (Reveal Formatting) or Alt+X | character is U+2665, text not an image/field | |
| 6 | Type `AKQ` right after a ♥ | `AKQ` is in the document's normal colour, not red | |
| 7 | Same as 6 with *Keep the text typed next uncoloured* off | `AKQ` is red (expected Word behaviour; documents why the option exists) | |
| 8 | Paragraph in Arial 14 pt: press ♥ mid-sentence | ♥ is red, Arial 14 pt (plugin log: `inserted hearts in Arial 14pt`) | |
| 8b | Paragraph in Aptos (or Calibri) 11 pt: press ♥ then type `AKQ` | ♥ red in Segoe UI Symbol 11 pt (Aptos has no suit glyphs); `AKQ` in Aptos 11 pt, not red | |
| 8c | Word just started and never lost focus: press ♥ | still inserted in red; log may show no font (COM not registered yet, KB 238610); after Alt+Tab away and back, font matching works | |
| 9 | Repeat 8 in a Heading 1 paragraph and in a table cell | as 8, no new paragraph or line break | |
| 10 | Repeat 8 with Clipboard = *RTF only*, then *HTML only* | record which mode keeps font/size best | |
| 11 | Select a word, press ♣ | selection replaced by green ♣ only | |
| 12 | Press ♥ ten times fast | ten red ♥, nothing else | |
| 13 | Copy the text `hello` (Ctrl+C), press ♠, then Ctrl+V | `hello` pasted: clipboard restored | |
| 14 | Copy an image (e.g. Snipping Tool), press ♦, paste into Paint | the image: clipboard restored | |
| 15 | Copy cells in Excel, press ♥ in Word, paste back into Excel | cells pasted (marching ants disappearing is expected) | |
| 16 | Win+V history after several presses | no ♠♥♦♣ entries, no duplicated original entry | |
| 17 | Focus Notepad, press ♥ | plain ♥ inserted (no colour support) | |
| 18 | Focus the desktop / no text field, press ♥ | key shows ⚠; log says `paste_not_observed`; clipboard unchanged | |
| 19 | Word started *as administrator*, press ♥ | key shows ⚠; log says `target_elevated` | |
| 20 | Hold Shift, press ♥, keep Shift held 2 s | key shows ⚠ `modifier_held`; nothing pasted | |
| 21 | Watch the screen while pressing | no console or window flashes, focus stays in Word | |
| 22 | Disconnect network, restart Stream Deck, press ♥ | still works | |

Log location: `%APPDATA%\Elgato\StreamDeck\Plugins\com.monxas.bridgesuits.sdPlugin\logs\`.

Record any failure with the Word version, the Clipboard mode and the log line.
