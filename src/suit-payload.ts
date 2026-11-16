import type { PasteRequest } from "./paste-helper";
import { buildClipboardPayload, isPasteFormats, type PasteFormats, type RichText } from "./richtext";
import { BRIDGE_SUITS, type BridgeSuit, resolveSuit } from "./suits";

export type BridgeSuitSettings = {
	suit?: BridgeSuit;
	/** Advanced: which rich clipboard formats to offer. Default "auto" (HTML + RTF + text). */
	formats?: PasteFormats;
	/** Advanced: send Ctrl+Space in Word afterwards so subsequent typing is not coloured. Default true. */
	resetWordFormatting?: boolean;
};

export function suitRichText(suit: BridgeSuit): RichText {
	const { symbol, color } = BRIDGE_SUITS[suit];
	return [{ text: symbol, color }];
}

export function pasteRequestFor(settings: BridgeSuitSettings): PasteRequest {
	const formats = isPasteFormats(settings.formats) ? settings.formats : "auto";
	return {
		...buildClipboardPayload(suitRichText(resolveSuit(settings.suit)), formats),
		resetWordFormatting: settings.resetWordFormatting !== false,
	};
}
