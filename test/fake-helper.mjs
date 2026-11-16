// Stand-in for bridge-paste-helper.exe used by the protocol tests.
// Echoes decoded text back as the note; "crash" text makes it exit.
import { createInterface } from "node:readline";
process.stdout.write("ready fake\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const [id, flags, text] = line.split(" ");
	const decoded = Buffer.from(text, "base64").toString("utf8");
	if (decoded === "crash") process.exit(3);
	if (decoded === "fail") return void process.stdout.write(`${id} error clipboard_busy locked by test\n`);
	if (decoded === "silent") return;
	process.stdout.write(`event restore_partial test event\n${id} ok ${decoded} flags=${flags}\n`);
});
