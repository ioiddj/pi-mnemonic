export async function PromptStructured(
	ctx: any,
	system: string,
	prompt: string,
	maxTokens = 800,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	const model = ctx?.model;
	if (!model || typeof ctx?.modelRegistry?.complete !== "function") return undefined;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{ role: "system", content: [{ type: "text", text: system }], timestamp: Date.now() },
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
				],
			},
			{ maxTokens, signal: signal ?? ctx.signal },
		);
		const text = (response.content || [])
			.filter((part: any) => part?.type === "text")
			.map((part: any) => String(part.text || ""))
			.join("\n")
			.slice(0, 20_000);
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		return JSON.parse(match[0]) as Record<string, unknown>;
	} catch (error) {
		if ((signal ?? ctx.signal)?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		return undefined;
	}
}
