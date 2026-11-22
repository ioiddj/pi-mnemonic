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

test("missing references render empty and Vars override registers", () => {
	assert.equal(RenderTemplate("x={{missing.y}}!", {}), "x=!");
	assert.equal(RenderTemplate("{{Port}}", { Port: "1111" }), "1111");
});
