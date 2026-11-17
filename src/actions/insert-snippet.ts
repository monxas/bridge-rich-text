import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { snippetFromCapture } from "../capture";
import { needsProbe, previewOf, type SnippetSettings, snippetKeyImage, snippetRequestFor } from "../snippet";
import type { Inserter } from "./insert-bridge-suit";

@action({ UUID: "com.monxas.bridgesuits.snippet" })
export class InsertSnippet extends SingletonAction<SnippetSettings> {
	constructor(private readonly inserter: Inserter) {
		super();
	}

	override async onWillAppear(ev: WillAppearEvent<SnippetSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(snippetKeyImage(ev.payload.settings.snippet));
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SnippetSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(snippetKeyImage(ev.payload.settings.snippet));
		await streamDeck.ui.sendToPropertyInspector(previewOf(ev.payload.settings));
	}

	override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<SnippetSettings>): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(previewOf(await ev.action.getSettings()));
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SnippetSettings>): Promise<void> {
		const event = ev.payload && typeof ev.payload === "object" && !Array.isArray(ev.payload) ? ev.payload.event : undefined;
		if (event !== "capture") return;
		const settings = await ev.action.getSettings();
		try {
			const result = snippetFromCapture(await this.inserter.capture());
			if (!result) {
				await streamDeck.ui.sendToPropertyInspector({ ...previewOf(settings), message: "The clipboard has no text. Copy something first." });
				return;
			}
			const next: SnippetSettings = { ...settings, snippet: result.runs, source: result.source };
			await ev.action.setSettings(next);
			if (ev.action.isKey()) await ev.action.setImage(snippetKeyImage(next.snippet));
			await streamDeck.ui.sendToPropertyInspector(previewOf(next));
			streamDeck.logger.info(`captured ${result.runs.length} run(s) from ${result.source}`);
		} catch (err) {
			streamDeck.logger.error(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
			await streamDeck.ui.sendToPropertyInspector({ ...previewOf(settings), message: `Capture failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	override async onKeyDown(ev: KeyDownEvent<SnippetSettings>): Promise<void> {
		const settings = ev.payload.settings;
		try {
			if (!settings.snippet?.length) throw new Error("nothing captured yet: open the key's settings and press Capture");
			const cursor = needsProbe(settings)
				? await this.inserter.probe().catch((err: unknown) => {
						streamDeck.logger.warn(`font probe failed, inserting without cursor font: ${String(err)}`);
						return {};
					})
				: {};
			const request = snippetRequestFor(settings, cursor);
			if (!request) throw new Error("empty snippet");
			const note = await this.inserter.paste(request);
			streamDeck.logger.info(`inserted snippet "${request.text.slice(0, 40)}"${note ? ` (${note})` : ""}`);
		} catch (err) {
			streamDeck.logger.error(`inserting snippet failed: ${err instanceof Error ? err.message : String(err)}`);
			await ev.action.showAlert();
		}
	}
}
