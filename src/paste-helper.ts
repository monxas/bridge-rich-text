import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClipboardPayload } from "./richtext";

/**
 * Client for the persistent native Windows helper (native/bridge-paste-helper.c).
 *
 * Protocol: one request per line on the helper's stdin, all fields
 * space-separated, binary fields base64 (UTF-8) or "-" when absent:
 *
 *   <id> <flags> <text> <cf_html> <rtf>
 *
 * The helper answers each request, in order, with one line on stdout:
 *
 *   <id> ok [note]
 *   <id> error <code> <message>
 *
 * and may emit unsolicited lines: "ready <version>" and "event <kind> <message>".
 */

export const FLAG_RESET_WORD_FORMATTING = 1;

export interface PasteRequest extends ClipboardPayload {
	/** Send Ctrl+Space after the paste when the foreground window is Microsoft Word. */
	resetWordFormatting?: boolean;
}

export interface Logger {
	info(...args: unknown[]): unknown;
	warn(...args: unknown[]): unknown;
	error(...args: unknown[]): unknown;
}

export class PasteError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
	}
}

export type HelperResponse =
	| { kind: "ok"; id: string; note: string }
	| { kind: "error"; id: string; code: string; message: string }
	| { kind: "ready"; version: string }
	| { kind: "event"; event: string; message: string };

const b64 = (value: string | undefined) => (value ? Buffer.from(value, "utf8").toString("base64") : "-");

export function encodeRequest(id: string, request: PasteRequest): string {
	if (!/^[A-Za-z0-9_-]{1,63}$/.test(id)) throw new Error(`Invalid request id "${id}"`);
	const flags = request.resetWordFormatting ? FLAG_RESET_WORD_FORMATTING : 0;
	return `${id} ${flags} ${b64(request.text)} ${b64(request.html)} ${b64(request.rtf)}\n`;
}

export function parseResponse(line: string): HelperResponse | undefined {
	const [head, ...rest] = line.trimEnd().split(" ");
	if (!head) return undefined;
	if (head === "ready") return { kind: "ready", version: rest.join(" ") };
	if (head === "event") return { kind: "event", event: rest[0] ?? "", message: rest.slice(1).join(" ") };
	if (rest[0] === "ok") return { kind: "ok", id: head, note: rest.slice(1).join(" ") };
	if (rest[0] === "error") return { kind: "error", id: head, code: rest[1] ?? "unknown", message: rest.slice(2).join(" ") };
	return undefined;
}

interface Pending {
	resolve(note: string): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export class PasteHelper {
	private child?: ChildProcess;
	private readonly pending = new Map<string, Pending>();
	private nextId = 1;

	constructor(
		private readonly command: string,
		private readonly logger: Logger,
		private readonly args: readonly string[] = [],
		/** Per request, including time spent queued behind earlier presses. */
		private readonly timeoutMs = 15_000,
	) {}

	/** Places the payload on the clipboard, pastes it, restores the clipboard. Resolves with the helper's note. */
	paste(request: PasteRequest): Promise<string> {
		const child = this.ensureStarted();
		const id = String(this.nextId++);
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new PasteError("timeout", `helper did not answer within ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin!.write(encodeRequest(id, request));
		});
	}

	dispose(): void {
		this.child?.stdin?.end();
		this.child = undefined;
	}

	private ensureStarted(): ChildProcess {
		if (this.child) return this.child;
		const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child = child;

		createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
		createInterface({ input: child.stderr! }).on("line", (line) => this.logger.warn(`helper stderr: ${line}`));
		child.stdin!.on("error", (err) => this.logger.error(`helper stdin: ${err.message}`));

		const onGone = (reason: string) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.logger.warn(`paste helper stopped (${reason}); it will be restarted on the next press`);
			for (const [id, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(new PasteError("helper_exited", reason));
				this.pending.delete(id);
			}
		};
		child.on("error", (err) => onGone(err.message));
		child.on("exit", (code, signal) => onGone(`exit code ${code ?? signal}`));
		return child;
	}

	private onLine(line: string): void {
		const msg = parseResponse(line);
		if (!msg) return void this.logger.warn(`unparseable helper output: ${line}`);
		switch (msg.kind) {
			case "ready":
				return void this.logger.info(`paste helper ready, version ${msg.version}`);
			case "event":
				return void this.logger.warn(`paste helper ${msg.event}: ${msg.message}`);
		}
		const p = this.pending.get(msg.id);
		if (!p) return void this.logger.warn(`late helper response: ${line}`);
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.kind === "ok") p.resolve(msg.note);
		else p.reject(new PasteError(msg.code, msg.message));
	}
}
