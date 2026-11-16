import streamDeck from "@elgato/streamdeck";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Inserter, InsertBridgeSuit } from "./actions/insert-bridge-suit";
import { PasteError, PasteHelper } from "./paste-helper";

streamDeck.logger.setLevel("info");

// bin/plugin.js -> ../native/<helper>
const nativeDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "native");
const HELPERS: Partial<Record<NodeJS.Platform, string>> = {
	win32: "bridge-paste-helper.exe",
	darwin: "bridge-paste-helper-macos",
};

function prepareMacHelper(file: string): void {
	// The plugin archive may not keep the executable bit, and a downloaded
	// archive may tag the helper with the quarantine attribute.
	try {
		chmodSync(file, 0o755);
	} catch (err) {
		streamDeck.logger.warn(`chmod helper: ${String(err)}`);
	}
	spawnSync("/usr/bin/xattr", ["-d", "com.apple.quarantine", file], { stdio: "ignore" });
}

let inserter: Inserter;
const helperName = HELPERS[process.platform];
if (helperName) {
	const file = path.join(nativeDir, helperName);
	if (process.platform === "darwin") prepareMacHelper(file);
	const helper = new PasteHelper(file, streamDeck.logger);
	inserter = helper;
	process.on("exit", () => helper.dispose());
} else {
	const unsupported = () => Promise.reject(new PasteError("unsupported_platform", `rich-text paste is not supported on ${process.platform}`));
	inserter = { probe: unsupported, paste: unsupported };
}

streamDeck.actions.registerAction(new InsertBridgeSuit(inserter));
streamDeck.connect();
