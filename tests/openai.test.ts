import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLedger, cacheStatus, keepalivesLeft, validSample, type Sample } from "../cache.ts";
import { sampleCost } from "../prices.ts";
import { openAi30m, openAiCaching, openAiOutputReserve, openAiReplay, openAiReplayReason, openAiUsage } from "../openai.ts";

const model = { id: "gpt-6.1-sol", api: "openai-codex-responses", provider: "openai-codex",
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } };
const real: Sample = { id: "real", kind: "real", model: "openai-codex/gpt-6.1-sol", startedAt: 1000,
	read: 0, write: 10_000, fresh: 0, output: 1, requested: "30m", declaredTtlMs: 1_800_000 };

test("30m policy targets GPT-5.6+ Responses, not older models or unrelated APIs", () => {
	for (const id of ["gpt-5.6", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol", "openai/gpt-10-sol"]) assert.ok(openAi30m({ ...model, id }));
	for (const id of ["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5", "gpt-5-2025-08-07", "gpt-4.1", "claude-opus-5-5"]) assert.equal(openAi30m({ ...model, id }), false);
	assert.equal(openAi30m({ ...model, api: "anthropic-messages" }), false);
});

test("explicit-only caching requires an actual breakpoint", () => {
	assert.equal(openAiCaching({ prompt_cache_options: { mode: "explicit" }, input: [] }), false);
	assert.ok(openAiCaching({ prompt_cache_options: { mode: "explicit" }, input: [{ content: [{ prompt_cache_breakpoint: { mode: "explicit" } }] }] }));
});

test("replay preserves the full prefix and never injects Codex-unsupported output controls", () => {
	const original = { input: [{ role: "developer", content: "instructions" }, { role: "user", content: "real request" }],
		tools: [{ type: "function", name: "test" }], reasoning: { effort: "high", context: "all_turns" }, prompt_cache_key: "stable", text: { format: { type: "json_object" } } };
	const copy = structuredClone(original);
	const replay = openAiReplay(model, original);
	assert.deepEqual(replay.input.slice(0, -1), original.input);
	assert.deepEqual(original, copy);
	assert.equal(replay.max_output_tokens, undefined);
	assert.equal(replay.prompt_cache_retention, undefined);
	assert.equal(replay.prompt_cache_options, undefined);
	assert.equal(openAiOutputReserve(model, original), 256);
	const publicModel = { ...model, api: "openai-responses" };
	assert.equal(openAiReplay(publicModel, { ...original, max_output_tokens: 4096 }).max_output_tokens, 16);
	assert.equal(openAiReplay(publicModel, original).max_output_tokens, undefined); // sign-in omitted this field
});

test("stateful IDs and server-side tools are rejected instead of executing side effects", () => {
	assert.ok(openAiReplayReason(model, { input: [], previous_response_id: "prior" }));
	assert.ok(openAiReplayReason(model, { input: [], tools: [{ type: "web_search" }] }));
	assert.equal(openAiReplayReason(model, { input: [], tools: [{ type: "namespace", tools: [{ type: "custom" }] }] }), undefined);
});

test("read/write/fresh/output usage is split without double-counting reasoning", () => {
	assert.deepEqual(openAiUsage({ input_tokens: 105, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 }, output_tokens: 8,
		output_tokens_details: { reasoning_tokens: 6 } }), { read: 80, write: 20, fresh: 5, output: 8 });
	for (const usage of [undefined, {}, { input_tokens: -1 }, { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } }, { input_tokens: 1, output_tokens: NaN }])
		assert.equal(openAiUsage(usage), undefined);
});

test("30m survives persisted validation, hits renew it, and expiry is exact", () => {
	assert.ok(validSample(real));
	assert.equal(cacheStatus(buildLedger([real]), 1_771_000).leftMs, 30_000);
	assert.equal(cacheStatus(buildLedger([real]), 1_801_000).state, "expired");
	const warm: Sample = { ...real, id: "warm", kind: "keepalive", startedAt: 1_771_000, read: 10_000, write: 20 };
	assert.equal(cacheStatus(buildLedger([real, warm]), 1_771_000).leftMs, 1_800_000);
	assert.equal(cacheStatus(buildLedger([real, warm]), 1_771_000).ttl, "30m");
});

test("unknown probe costs exhaust default budgets, survive reload, and are not estimated as zero", () => {
	const unknown: Sample = { ...real, kind: "keepalive", id: "unknown", startedAt: 1_771_000, write: 0, usageUnknown: true };
	const ledger = buildLedger(JSON.parse(JSON.stringify([real, unknown])));
	assert.equal(keepalivesLeft(ledger, { read: 0.05, output: 5, fiveMinute: 1.25 }), 0);
	assert.equal(keepalivesLeft(ledger, null, 2), 1); // explicit numeric limits still count attempts
	assert.equal(sampleCost(model, unknown), null);
	assert.equal(cacheStatus(ledger, 1_771_000).leftMs, 30_000); // no false refresh
	assert.equal(validSample({ ...real, usageUnknown: true }), false);
});

test("budgets include suffix/output reserves and actual warm cache writes", () => {
	const prices = { read: 0.05, output: 5, fiveMinute: 1.25 };
	const ledger = buildLedger([real]);
	assert.ok(keepalivesLeft(ledger, prices, undefined, false, 64 * 1.25 + 255 * 5)! < keepalivesLeft(ledger, prices)!);
	const warm: Sample = { ...real, kind: "keepalive", id: "warm", startedAt: 1_771_000, read: 10_000, write: 20, fresh: 5, output: 8 };
	assert.equal(sampleCost(model, warm), (10_000 * 0.1 + 20 * 2.5 + 5 * 2 + 8 * 10) / 1_000_000);
});
