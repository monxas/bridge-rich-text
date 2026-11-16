import type { InsertionFormat, PasteRequest } from "./paste-helper";
import { buildClipboardPayload, isPasteFormats, type PasteFormats, type RichText } from "./richtext";
import { BRIDGE_SUITS, type BridgeSuit, resolveSuit } from "./suits";

export type BridgeSuitSettings = {
	suit?: BridgeSuit;
	/** Advanced: which rich clipboard formats to offer. Default "auto" (HTML + RTF + text). */
	formats?: PasteFormats;
	/** Advanced: after inserting in Word, give the text typed next its previous colour again. Default true. */
	resetWordFormatting?: boolean;
	/** Advanced: use the font and size at Word's insertion point. Default true. */
	matchWordFont?: boolean;
};

export function suitRichText(suit: BridgeSuit, format: InsertionFormat = {}): RichText {
	const { symbol, color } = BRIDGE_SUITS[suit];
	return [{ text: symbol, color, font: format.font, sizePt: format.sizePt }];
}

/**
 * What "auto" means per platform, from tests in the real Word:
 * Word for Mac prefers HTML when both are offered, and its HTML import draws
 * ♠♥♦♣ with Apple Color Emoji in fonts such as Times New Roman, while its RTF
 * import keeps the font. So on macOS "auto" offers RTF (+ plain text) only.
 */
export function effectiveFormats(formats: PasteFormats, platform: NodeJS.Platform): PasteFormats {
	return formats === "auto" && platform === "darwin" ? "rtf" : formats;
}

export function pasteRequestFor(
	settings: BridgeSuitSettings,
	format: InsertionFormat = {},
	platform: NodeJS.Platform = process.platform,
): PasteRequest {
	const formats = effectiveFormats(isPasteFormats(settings.formats) ? settings.formats : "auto", platform);
	return {
		...buildClipboardPayload(suitRichText(resolveSuit(settings.suit), format), formats),
		resetWordFormatting: settings.resetWordFormatting !== false,
	};
}
