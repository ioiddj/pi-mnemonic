/**
 * Optional model-backed structured output. All model access is capability-based:
 * a context without a model or completion provider falls back deterministically.
 */

interface StructuredContext {
	readonly model?: unknown;
	readonly signal?: AbortSignal;
	readonly modelRegistry?: object;
}

interface CompleteCapability {
	readonly complete?: (
		model: unknown,
		context: { readonly messages: readonly unknown[] },
		options: { readonly maxTokens: number; readonly signal?: AbortSignal },
	) => Promise<{ readonly content?: readonly unknown[] }>;
}

function TextFromContent(content: readonly unknown[] | undefined): string {
	if (!content) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return "";
			const text = "text" in part ? (part as { readonly text?: unknown }).text : undefined;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

export async function PromptStructured(
	ctx: unknown,
	system: string,
	prompt: string,
	maxTokens = 800,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	const context = (ctx && typeof ctx === "object" ? ctx : {}) as StructuredContext;
	const model = context.model;
	const registry = context.modelRegistry as CompleteCapability | undefined;
	if (!model || typeof registry?.complete !== "function") return undefined;
	try {
		const response = await registry.complete(
			model,
			{
				messages: [
					{ role: "system", content: [{ type: "text", text: system }], timestamp: Date.now() },
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
				],
			},
			{ maxTokens, signal: signal ?? context.signal },
		);
		const text = TextFromContent(response.content).slice(0, 20_000);
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		return JSON.parse(match[0]) as Record<string, unknown>;
	} catch (error) {
		if ((signal ?? context.signal)?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		return undefined;
	}
}
