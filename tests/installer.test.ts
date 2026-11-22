import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts", "pi-mnemonic-install.mjs");

function run(args: string[]) {
	return spawnSync(process.execPath, [script, ...args, "--dry-run"], { encoding: "utf8", cwd: root });
}

test("installer defaults to git source", () => {
	const result = run([]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /\$ pi install git:github\.com\/ioiddj\/pi-mnemonic/);
});

test("installer supports npm, local, project scope, and uninstall", () => {
	assert.match(run(["--npm"]).stdout, /\$ pi install npm:@ioiddj\/pi-mnemonic/);
	assert.match(run(["--local"]).stdout, /\$ pi install .*pi-mnemonic/);
	assert.match(run(["--project"]).stdout, /-l/);
	const uninstall = run(["--uninstall"]);
	assert.equal(uninstall.status, 0);
	assert.match(uninstall.stdout, /\$ pi remove git:github\.com\/ioiddj\/pi-mnemonic/);
	assert.match(uninstall.stdout, /\$ pi remove npm:@ioiddj\/pi-mnemonic/);
});
