import Handlebars from "../vendor/handlebars-ai/index.ts";

const env = Handlebars.create();

env.registerHelper("count", (value: unknown) => {
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === "object") return Object.keys(value as object).length;
	return 0;
});

env.registerHelper("at", (value: unknown, path: unknown) => {
	let current: any = value;
	for (const part of String(path ?? "").split(".").filter(Boolean)) {
		if (current === null || current === undefined) return undefined;
		current = current[ /^\d+$/.test(part) ? Number(part) : part ];
	}
	return current;
});

export function RenderMarkdown(template: string, context: Record<string, unknown> = {}): string {
	const secrets: string[] = [];
	const protectedText = template.replace(/\{\{(?:secret|credential):[^}]+\}\}/g, (token) => {
		secrets.push(token);
		return `__PI_MNEMONIC_TOKEN_${secrets.length - 1}__`;
	});
	const rendered = RenderTemplate(protectedText, context);
	return secrets.reduce((text, token, index) => text.replace(`__PI_MNEMONIC_TOKEN_${index}__`, token), rendered);
}

export function RenderTemplate(template: string, context: Record<string, unknown> = {}): string {
	try {
		return env.compile(template, { noEscape: true, strict: false })(context) as string;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Template render failed: ${message}. Hint: check {{references}} and pass Vars for missing keys.`);
	}
}
