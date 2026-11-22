import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderMarkdown, RenderTemplate } from "../src/template.ts";

test("renders nested paths without HTML escaping", () => {
	const out = RenderTemplate("port={{hosts.dev.port}} host={{hosts.dev.name}}", {
		hosts: { dev: { port: 8787, name: "a&b" } },
	});
	assert.equal(out, "port=8787 host=a&b");
});

test("supports each, lookup, count, and at", () => {
	const ctx = { items: [{ name: "one" }, { name: "two" }] };
	assert.equal(RenderTemplate("{{#each items}}{{name}};{{/each}}", ctx), "one;two;");
	assert.equal(RenderTemplate("{{items.1.name}}", ctx), "two");
	assert.equal(RenderTemplate("{{lookup (at items 1) \"name\"}}", ctx), "two");
	assert.equal(RenderTemplate("{{count items}}", ctx), "2");
	assert.equal(RenderTemplate("{{at items \"0.name\"}}", ctx), "one");
});

test("RenderMarkdown interpolates registers but preserves secret macros", () => {
	assert.equal(
		RenderMarkdown("Port {{hosts.port}} and {{secret:API_KEY}}", { hosts: { port: "8787" } }),
		"Port 8787 and {{secret:API_KEY}}",
	);
});

test("hint helper inlines cached values and only asks for a tool call when truncated or missing", () => {
	const short = RenderMarkdown('{{hint "research.short"}}', { research: { short: "Use xvfb-run with GLX disabled" } });
	assert.equal(short, "- research.short: Use xvfb-run with GLX disabled");

	const value = `${"verbose cached detail ".repeat(100)}token=abc123`;
	const out = RenderMarkdown('{{hint "research.long"}}', { research: { long: value } });
	assert.match(out, /^- research\.long: verbose cached detail/);
	assert.match(out, /Truncated; exact value: PiMnemonicGet Key=research\.long\.$/);
	assert.ok(out.length < 1400);
	assert.doesNotMatch(out, /token=abc123/);

	const missing = RenderMarkdown('{{hint "research.launcherGnome"}}', { research: { long: value } });
	assert.match(missing, /^\[missing store key: research\.launcherGnome\] Nearby keys: long\.$/);
});

test('repeated secret macros and sentinel-like text stay intact', () => {
	const out = RenderMarkdown('A={{secret:KEY}} __PI_MNEMONIC_fake_ B={{secret:KEY}}', {});
	assert.equal((out.match(/\{\{secret:KEY\}\}/g) || []).length, 2);
	assert.ok(out.includes('__PI_MNEMONIC_fake_'));
	assert.doesNotMatch(out, /__PI_MNEMONIC_[0-9a-f]{32}/);
});

test('helpers ignore missing arguments instead of leaking options objects', () => {
	assert.equal(RenderMarkdown('{{hint}}', { deploy_token: 'v' }), '');
	assert.equal(RenderTemplate('{{count}}', {}), '0');
});

test("missing references render empty and Vars override registers", () => {
	assert.equal(RenderTemplate("x={{missing.y}}!", {}), "x=!");
	assert.equal(RenderTemplate("{{Port}}", { Port: "1111" }), "1111");
});
