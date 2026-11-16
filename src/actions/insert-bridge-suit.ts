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
import type { PasteRequest } from "../paste-helper";

export type Paster = (request: PasteRequest) => Promise<string>;

@action({ UUID: "com.monxas.bridgesuits.insert" })
export class InsertBridgeSuit extends SingletonAction<BridgeSuitSettings> {
	constructor(private readonly paste: Paster) {
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
			const note = await this.paste(pasteRequestFor(ev.payload.settings));
			streamDeck.logger.info(`inserted ${suit}${note ? ` (${note})` : ""}`);
		} catch (err) {
			streamDeck.logger.error(`inserting ${suit} failed: ${err instanceof Error ? err.message : String(err)}`);
			await ev.action.showAlert();
		}
	}
}
