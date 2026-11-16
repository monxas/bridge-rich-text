import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { encodeRequest, parseResponse, PasteError, PasteHelper } from "../src/paste-helper";

const fake = fileURLToPath(new URL("./fake-helper.mjs", import.meta.url));
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("protocol", () => {
	it("encodes fields as base64 with '-' for absent formats", () => {
		const line = encodeRequest("7", { text: "♥", rtf: "{\\rtf1}", resetWordFormatting: true });
		expect(line).toBe(`7 1 ${Buffer.from("♥").toString("base64")} - ${Buffer.from("{\\rtf1}").toString("base64")}\n`);
	});

	it("parses all response kinds", () => {
		expect(parseResponse("3 ok")).toEqual({ kind: "ok", id: "3", note: "" });
		expect(parseResponse("3 error clipboard_busy is locked")).toEqual({ kind: "error", id: "3", code: "clipboard_busy", message: "is locked" });
		expect(parseResponse("ready 1.0.0")).toEqual({ kind: "ready", version: "1.0.0" });
		expect(parseResponse("event restore_failed x y")).toEqual({ kind: "event", event: "restore_failed", message: "x y" });
		expect(parseResponse("garbage")).toBeUndefined();
	});
});

describe("PasteHelper client", () => {
	it("pipelines sequential requests through one persistent process", async () => {
		const log = logger();
		const helper = new PasteHelper(process.execPath, log, [fake]);
		const results = await Promise.all(["a", "b", "c"].map((text) => helper.paste({ text, resetWordFormatting: true })));
		expect(results).toEqual(["a flags=1", "b flags=1", "c flags=1"]);
		expect(log.info).toHaveBeenCalledWith("paste helper ready, version fake");
		expect(log.warn).toHaveBeenCalledWith("paste helper restore_partial: test event");
		helper.dispose();
	});

	it("maps helper errors to PasteError", async () => {
		const helper = new PasteHelper(process.execPath, logger(), [fake]);
		await expect(helper.paste({ text: "fail" })).rejects.toMatchObject({ code: "clipboard_busy" });
		helper.dispose();
	});

	it("rejects pending requests when the helper dies and restarts it on the next press", async () => {
		const helper = new PasteHelper(process.execPath, logger(), [fake]);
		await expect(helper.paste({ text: "crash" })).rejects.toBeInstanceOf(PasteError);
		await expect(helper.paste({ text: "again" })).resolves.toBe("again flags=0");
		helper.dispose();
	});

	it("times out when the helper does not answer", async () => {
		const helper = new PasteHelper(process.execPath, logger(), [fake], 200);
		await expect(helper.paste({ text: "silent" })).rejects.toMatchObject({ code: "timeout" });
		helper.dispose();
	});

	it("reports a missing executable instead of hanging", async () => {
		const helper = new PasteHelper("/nonexistent/bridge-paste-helper.exe", logger());
		await expect(helper.paste({ text: "x" })).rejects.toMatchObject({ code: "helper_exited" });
	});
});
