// Writes helper request lines (the exact bytes the plugin sends) for the Windows harness.
import { writeFileSync } from "node:fs";
import { encodeRequest } from "../../src/paste-helper";
import { pasteRequestFor } from "../../src/suit-payload";

const out = process.argv[2] ?? "dist/windows-test";
writeFileSync(
	`${out}/requests-chain.txt`,
	encodeRequest("1", pasteRequestFor({ suit: "hearts" }, {}, "win32")) +
		encodeRequest("2", pasteRequestFor({ suit: "clubs", formats: "rtf" }, {}, "win32")) +
		encodeRequest("3", pasteRequestFor({ suit: "spades", resetWordFormatting: false }, {}, "win32")),
);
writeFileSync(`${out}/requests-one.txt`, encodeRequest("1", pasteRequestFor({ suit: "diamonds" }, {}, "win32")));
