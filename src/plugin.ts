import streamDeck from "@elgato/streamdeck";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InsertBridgeSuit, type Paster } from "./actions/insert-bridge-suit";
import { PasteError, PasteHelper } from "./paste-helper";

streamDeck.logger.setLevel("info");

let paste: Paster;
if (process.platform === "win32") {
	// bin/plugin.js -> ../native/bridge-paste-helper.exe
	const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const helper = new PasteHelper(path.join(pluginDir, "native", "bridge-paste-helper.exe"), streamDeck.logger);
	paste = (request) => helper.paste(request);
	process.on("exit", () => helper.dispose());
} else {
	paste = () => Promise.reject(new PasteError("unsupported_platform", `rich-text paste is Windows-only (running on ${process.platform})`));
}

streamDeck.actions.registerAction(new InsertBridgeSuit(paste));
streamDeck.connect();
