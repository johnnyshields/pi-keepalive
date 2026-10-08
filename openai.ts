/** OpenAI GPT-5.6+ cache policy and cache-preserving Responses replays. */
export const OPENAI_TTL_MS = 1_800_000;
export const OPENAI_OUTPUT_CAP = 16; // pi's Responses adapter minimum
export const CODEX_OUTPUT_RESERVE = 256; // estimate, not an endpoint-enforced cap
const WARM_PROMPT = "Cache maintenance only. Do not call tools. Reply with only: OK.";

export function openAi30m(model: any): boolean {
	if (model?.api !== "openai-responses" && model?.api !== "openai-codex-responses") return false;
	const version = /(?:^|\/)gpt-(\d+)(?:[.-](\d{1,2}))?(?:[-/]|$)/i.exec(model.id ?? "");
	return !!version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6));
}

export function openAiCaching(payload: any): boolean {
	if (payload?.prompt_cache_options?.mode !== "explicit") return true;
	// Explicit-only mode with no breakpoints is pi's cacheRetention:none. Never undo it.
	const stack = [payload.input, payload.tools];
	const seen = new Set<object>();
	while (stack.length) {
		const value = stack.pop();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		if (value.prompt_cache_breakpoint?.mode === "explicit") return true;
		stack.push(...Object.values(value));
	}
	return false;
}

export function openAiReplayReason(model: any, payload: any): string | undefined {
	if (!openAi30m(model)) return "OpenAI warming requires a GPT-5.6+ Responses model";
	if (!Array.isArray(payload?.input)) return "no stateless Responses input captured";
	if (payload.previous_response_id) return "stateful previous_response_id replay is not supported";
	if (!openAiCaching(payload)) return "the request disabled prompt caching";
	// Preserve tool declarations, but never replay server-executed tools with side effects.
	const localTools = (tools: any[]): boolean => tools.every(t => t?.type === "function" || t?.type === "custom" ||
		(t?.type === "namespace" && Array.isArray(t.tools) && localTools(t.tools)));
	if (payload.tools !== undefined && (!Array.isArray(payload.tools) || !localTools(payload.tools)))
		return "server-executed tools cannot be replayed safely";
	return undefined;
}

export function openAiOutputReserve(model: any, payload: any): number {
	// Only reuse output-limit support demonstrated by the successful main request.
	// ChatGPT sign-in, including Codex, omits/rejects this field.
	return model?.api === "openai-responses" && Number.isSafeInteger(payload?.max_output_tokens) && payload.max_output_tokens > 0
		? OPENAI_OUTPUT_CAP : CODEX_OUTPUT_RESERVE;
}

export function openAiReplay(model: any, original: any): any {
	const payload = structuredClone(original);
	if (openAiOutputReserve(model, original) === OPENAI_OUTPUT_CAP) payload.max_output_tokens = OPENAI_OUTPUT_CAP;
	else delete payload.max_output_tokens;
	// Existing input, tools, schemas, reasoning, instructions and cache key remain unchanged.
	// Earlier eligible-message boundaries can still hit the original cache. The tiny new
	// suffix is billed and accounted for; the probe never enters the session conversation.
	payload.input.push({ role: "user", content: [{ type: "input_text", text: WARM_PROMPT }] });
	return payload;
}

export function openAiUsage(usage: any): { read: number; write: number; fresh: number; output: number } | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const input = usage.input_tokens ?? 0;
	const read = usage.input_tokens_details?.cached_tokens ?? 0;
	const write = usage.input_tokens_details?.cache_write_tokens ?? 0;
	const output = usage.output_tokens ?? 0; // already includes reasoning tokens
	if (![input, read, write, output].every(v => Number.isSafeInteger(v) && v >= 0) || read + write > input || input + output === 0) return undefined;
	return { read, write, fresh: input - read - write, output };
}
