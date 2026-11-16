import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import { suitKeyImage } from "../render";
import { type BridgeSuitSettings, pasteRequestFor } from "../suit-payload";
import { resolveSuit } from "../suits";
import type { InsertionFormat, PasteRequest } from "../paste-helper";

/** What the action needs from the platform helper. */
export interface Inserter {
	probe(): Promise<InsertionFormat>;
	paste(request: PasteRequest): Promise<string>;
}

@action({ UUID: "com.monxas.bridgesuits.insert" })
export class InsertBridgeSuit extends SingletonAction<BridgeSuitSettings> {
	constructor(private readonly inserter: Inserter) {
		super();
	}

	override async onWillAppear(ev: WillAppearEvent<BridgeSuitSettings>): Promise<void> {
		const suit = resolveSuit(ev.payload.settings.suit);
		if (ev.payload.settings.suit !== suit) await ev.action.setSettings({ ...ev.payload.settings, suit });
		if (ev.action.isKey()) await ev.action.setImage(suitKeyImage(suit));
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BridgeSuitSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(suitKeyImage(resolveSuit(ev.payload.settings.suit)));
	}

	override async onKeyDown(ev: KeyDownEvent<BridgeSuitSettings>): Promise<void> {
		const suit = resolveSuit(ev.payload.settings.suit);
		try {
			const settings = ev.payload.settings;
			let format: InsertionFormat = {};
			if (settings.matchWordFont !== false) {
				format = await this.inserter.probe().catch((err: unknown) => {
					streamDeck.logger.warn(`font probe failed, inserting without font: ${String(err)}`);
					return {};
				});
			}
			const note = await this.inserter.paste(pasteRequestFor(settings, format));
			streamDeck.logger.info(`inserted ${suit}${format.font ? ` in ${format.font} ${format.sizePt ?? "?"}pt` : ""}${note ? ` (${note})` : ""}`);
		} catch (err) {
			streamDeck.logger.error(`inserting ${suit} failed: ${err instanceof Error ? err.message : String(err)}`);
			await ev.action.showAlert();
		}
	}
}
