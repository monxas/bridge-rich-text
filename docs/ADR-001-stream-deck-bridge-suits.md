# ADR-001: Stream Deck Bridge Suit Symbols Plugin

**Status:** Proposed  
**Date:** 2026-11-16  
**Project:** Bridge Rich Text  
**Target:** Elgato Stream Deck on Windows 10/11  
**Primary application:** Microsoft Word  
**License:** MIT

## 1. Context

The native Elgato Stream Deck **Text** action inserts plain Unicode text but does not preserve rich text formatting.

Bridge uses four Unicode playing-card suit symbols with specific foreground colors:

| Suit | Unicode | Character | Color | HEX |
|---|---|---|---|---|
| Spades | U+2660 | ♠ | Black | `#111111` |
| Hearts | U+2665 | ♥ | Red | `#DC0000` |
| Diamonds | U+2666 | ♦ | Red | `#DC0000` |
| Clubs | U+2663 | ♣ | Green | `#008A35` |

The requirement is to insert these exact Unicode characters into Microsoft Word with their corresponding **font colors**, not as colored emoji, images, or alternative Unicode symbols.

The implementation must be free, locally executable, and independent of commercial plugins.

## 2. Decision

Develop a native Stream Deck plugin using the official Elgato Stream Deck SDK and TypeScript.

The plugin will provide a configurable action called **Insert Bridge Suit**.

Each action instance will allow selecting one of the four bridge suits and will insert its corresponding Unicode character with rich text formatting into the currently focused Windows application.

The solution will use the Windows clipboard to transfer formatted text, followed by a simulated paste operation.

A small native Windows helper may be used to access clipboard APIs unavailable through the Stream Deck JavaScript runtime.

### 2.1. Technical architecture

```text
Stream Deck hardware
        |
        v
Stream Deck Plugin
(TypeScript / Elgato SDK)
        |
        v
Native Windows Helper
        |
        v
Windows Clipboard
(CF_UNICODETEXT + CF_HTML + optional RTF)
        |
        v
Simulated Ctrl+V
        |
        v
Microsoft Word
(Unicode character + font color)
```

### 2.2. Technology stack

- TypeScript
- Official Elgato Stream Deck SDK
- Node.js for development tooling
- Windows native clipboard API
- C#/.NET or a similarly lightweight native helper, if required
- HTML Clipboard Format (`CF_HTML`)
- Unicode Clipboard Format (`CF_UNICODETEXT`)
- Optional Rich Text Format (`Rich Text Format` clipboard registration)
- Windows `SendInput` API for keyboard simulation

Avoid AutoHotkey, third-party clipboard managers, and commercial dependencies.

## 3. Functional requirements

### FR-001: Four bridge suits

The plugin must support:

- Spades: `♠`, black
- Hearts: `♥`, red
- Diamonds: `♦`, red
- Clubs: `♣`, green

Symbols must be inserted as the exact Unicode code points defined above.

### FR-002: Configurable Stream Deck action

Provide one action, **Insert Bridge Suit**, with a Property Inspector containing a dropdown:

- Spades
- Hearts
- Diamonds
- Clubs

The selected suit is stored independently for each action instance using Stream Deck settings.

### FR-003: Button appearance

Each button must display its selected symbol in the corresponding color.

Icons should be generated as SVG assets or dynamically rendered SVGs.

Default appearance:

- Dark background
- Large centered suit symbol
- No additional text

### FR-004: Rich text insertion

When a button is pressed:

1. Determine the selected suit and color.
2. Prepare a clipboard payload containing the Unicode character and rich text formatting.
3. Register the corresponding clipboard formats.
4. Insert the formatted content into the active Microsoft Word document using a simulated `Ctrl+V`.
5. Preserve the inserted character as editable text, not an image.

Example HTML fragment:

```html
<span style="color:#DC0000">♥</span>
```

The actual Windows `CF_HTML` payload must comply with the Microsoft HTML Clipboard Format specification, including correctly calculated byte offsets for the fragment and document.

Include `CF_UNICODETEXT` as a fallback for applications that do not support rich text.

RTF may be included for compatibility, but must preserve exactly the same character and color.

### FR-005: Preserve Word formatting

Inserted text must:

- Have the correct foreground color.
- Remain normal, editable Unicode text.
- Respect the surrounding document's font family and font size where possible.
- Avoid unwanted font substitutions, paragraph breaks, images, or background styling.
- Not modify existing text beyond replacing the user's current selection when applicable.

Prefer minimal formatting: only set the foreground color.

### FR-006: Clipboard preservation

The plugin should preserve the user's previous clipboard contents.

Requirements:

- Do not overwrite the clipboard permanently.
- Preserve common formats, including text, HTML, RTF, and images, when feasible.
- Handle clipboard contention gracefully.
- Avoid restoring the clipboard before Word has consumed the paste operation.
- Do not overwrite clipboard content that the user or another process changed after the plugin initiated the paste.

Because clipboard preservation cannot be guaranteed atomically across arbitrary applications, document limitations and favor data safety over silently losing clipboard content.

### FR-007: Reliability

- No administrator privileges.
- No foreground window focus changes.
- No visible console windows.
- No dependency on internet access.
- Multiple sequential button presses must work reliably.
- Handle clipboard lock failures with bounded retries.
- Report failures in development logs.
- Respect Windows integrity-level restrictions when sending keyboard input.

## 4. Non-functional requirements

### NFR-001: Performance

Button presses should feel instantaneous under normal operating conditions.

Avoid launching a new heavy process for each press if a persistent helper can provide better responsiveness.

### NFR-002: Maintainability

Separate responsibilities into:

- Stream Deck action registration
- Settings management
- Suit definitions
- Button rendering
- Windows clipboard integration
- Keyboard input simulation

Do not scatter suit colors or Unicode values throughout the codebase.

### NFR-003: Extensibility

Design the insertion mechanism to support additional rich text snippets in the future without rewriting the Windows clipboard integration.

Do not implement a general-purpose rich text editor in the first version.

### NFR-004: Distribution

Provide:

- A locally installable `.streamDeckPlugin` package.
- Build scripts.
- Development instructions.
- Clear Windows prerequisites.
- Automated tests where practical.

No paid dependencies or subscription services.

## 5. Proposed data model

```typescript
type BridgeSuit =
  | "spades"
  | "hearts"
  | "diamonds"
  | "clubs";

interface SuitDefinition {
  symbol: string;
  color: string;
  label: string;
}

const BRIDGE_SUITS: Record<BridgeSuit, SuitDefinition> = {
  spades: {
    symbol: "\u2660",
    color: "#111111",
    label: "Spades",
  },
  hearts: {
    symbol: "\u2665",
    color: "#DC0000",
    label: "Hearts",
  },
  diamonds: {
    symbol: "\u2666",
    color: "#DC0000",
    label: "Diamonds",
  },
  clubs: {
    symbol: "\u2663",
    color: "#008A35",
    label: "Clubs",
  },
};
```

Instance settings:

```typescript
interface BridgeSuitSettings {
  suit: BridgeSuit;
}
```

## 6. Implementation milestones

### Phase 1: Plugin skeleton

- Initialize the official Stream Deck SDK project.
- Register the Insert Bridge Suit action.
- Implement Property Inspector configuration.
- Persist suit selection.
- Render the corresponding colored symbol on the hardware button.

### Phase 2: Windows clipboard integration

- Implement the native Windows helper.
- Implement proper `CF_HTML` formatting.
- Include `CF_UNICODETEXT`.
- Implement `Ctrl+V` using native Windows input APIs.
- Validate the complete round trip into Microsoft Word.

### Phase 3: Reliability

- Implement clipboard preservation where safe.
- Handle rapid consecutive button presses.
- Add error handling and diagnostics.
- Test Word formatting inheritance.
- Validate operation when Word is not focused.

### Phase 4: Packaging

- Package the plugin for local installation.
- Document installation and development workflows.
- Include all required runtime dependencies.
- Provide a reproducible release build.

## 7. Acceptance criteria

The implementation is complete when:

- [ ] Four independent Stream Deck buttons can be configured for the four suits.
- [ ] Each button displays the correct colored Unicode symbol.
- [ ] Pressing Hearts inserts `♥` in red into Microsoft Word.
- [ ] Pressing Diamonds inserts `♦` in red.
- [ ] Pressing Clubs inserts `♣` in green.
- [ ] Pressing Spades inserts `♠` in black.
- [ ] The resulting characters remain editable Unicode text.
- [ ] Insertion does not require changing the current Word text color manually.
- [ ] Insertion works repeatedly without accumulating formatting changes in subsequent typing.
- [ ] No visible terminal or extra application window appears.
- [ ] Clipboard handling does not silently destroy existing data.
- [ ] The plugin works offline.
- [ ] A distributable `.streamDeckPlugin` package can be built and installed locally.

## 8. Risks and trade-offs

**R1: Clipboard format compatibility**

Microsoft Word may prioritize RTF, HTML, or other clipboard representations depending on the available formats and paste settings.

Mitigation: Validate native Word behavior with real integration tests and adjust the clipboard payload accordingly.

**R2: Clipboard races**

There is no universally safe fixed delay after which clipboard restoration is guaranteed.

Mitigation: Implement conservative clipboard lifecycle management, detect conflicting changes, and document any unavoidable limitation.

**R3: Font inheritance**

HTML or RTF content may cause Word to apply an unexpected font or font size.

Mitigation: Use minimal rich text formatting and test insertion within paragraphs with different styles.

**R4: Stream Deck SDK limitations**

The official TypeScript SDK may not directly expose Windows clipboard APIs.

Mitigation: Isolate native operations behind a minimal Windows helper with a documented communication protocol.

**R5: Simulated keyboard input**

`SendInput` may fail when targeting higher-integrity processes or protected input environments.

Mitigation: Support normal non-elevated Word sessions and report unsupported conditions.

## 9. Out of scope

The initial version will not include:

- Full rich text editing.
- Custom Unicode symbols beyond the four bridge suits.
- macOS compatibility.
- Word-specific VBA macros.
- Word add-ins.
- Cloud synchronization.
- Paid extensions or external services.

## 10. Instructions for the implementation agent

Implement this ADR as a working repository, not merely a technical proposal.

1. Check the latest official Elgato Stream Deck SDK documentation before choosing APIs or project structure.
2. Prefer current, supported tooling and dependencies.
3. Do not assume the SDK exposes functionality it does not provide.
4. Implement the complete Windows clipboard integration, including valid `CF_HTML` offsets.
5. Prioritize verified behavior in Microsoft Word over architectural complexity.
6. If HTML alone is unreliable, implement an RTF fallback and test it.
7. Provide unit tests for formatting and payload generation.
8. Build a working plugin package.
9. Document exact installation, building, and debugging instructions.
10. Do not declare the Word integration verified unless it has actually been tested in Word. Clearly distinguish automated tests from manual integration tests.

**Final deliverable:** A complete, buildable, locally installable Stream Deck plugin that inserts the four colored Unicode bridge suits as editable formatted text in Microsoft Word, without VBA or commercial dependencies.