// Run: npm test (or node --test tests/*.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildLedger,
	cacheDial,
	cacheGrade,
	cacheStatus,
	keepalivesLeft,
	parseLimit,
	parseTokens,
	recentMisses,
	reportedCreation,
	type Sample,
	validSample,
} from "../cache.ts";
import { anthropicPrices, modelKey, registryPrices } from "../prices.ts";

const M = 60_000;
let n = 0;
function real(at: number, read: number, write: number, extra: Partial<Sample> = {}): Sample {
	return {
		id: `r${n++}`,
		kind: "real",
		model: "pantheon/claude-opus-5-5",
		startedAt: at,
		completedAt: at + 5000,
		read,
		write,
		fresh: 10,
		output: 100,
		creation: write ? { fiveMinute: write, oneHour: 0 } : undefined,
		requested: "5m",
		...extra,
	};
}
function keepalive(at: number, read: number): Sample {
	return { id: `k${n++}`, kind: "keepalive", via: "keepalive", model: "pantheon/claude-opus-5-5", startedAt: at, completedAt: at + 1000, read, write: 0, fresh: 8, output: 1, requested: "5m" };
}

test("countdown runs from the dispatch of the latest cache touch", () => {
	const t0 = 1_000_000;
	const ledger = buildLedger([real(t0, 0, 50_000), real(t0 + M, 50_000, 2_000)]);
	const s = cacheStatus(ledger, t0 + 2 * M);
	assert.equal(s.state, "warm");
	assert.equal(s.basis, "reported");
	assert.equal(s.ttl, "5m");
	assert.equal(s.leftMs, 4 * M);
	assert.equal(cacheDial(s), "●");
	assert.equal(cacheStatus(ledger, t0 + 7 * M).state, "expired");
	// a request in flight restarts the countdown
	assert.equal(cacheStatus(ledger, t0 + 3 * M, t0 + 3 * M).leftMs, 5 * M);
});

test("read-only requests keep the TTL of the latest write; 1h writes count down an hour", () => {
	const t0 = 0;
	const ledger = buildLedger([real(t0, 0, 40_000, { creation: { fiveMinute: 0, oneHour: 40_000 }, requested: "1h" }), real(t0 + M, 40_000, 0, { requested: "1h" })]);
	const s = cacheStatus(ledger, t0 + 2 * M);
	assert.equal(s.ttl, "1h");
	assert.equal(s.leftMs, 59 * M);
});

test("unreported TTL falls back to the declared models.json lifetime, then to 'TTL not reported'", () => {
	const declared = buildLedger([real(0, 0, 40_000, { creation: undefined, requested: undefined, declaredTtlMs: 300_000, model: "openai-codex/gpt-6-sol" })]);
	const s = cacheStatus(declared, M);
	assert.equal(s.basis, "declared");
	assert.equal(s.leftMs, 4 * M);
	const unknown = buildLedger([real(0, 0, 40_000, { creation: undefined, requested: undefined })]);
	assert.equal(cacheStatus(unknown, M).state, "TTL not reported");
	const awaiting = buildLedger([real(0, 0, 40_000, { creation: undefined, requested: "1h", completedAt: undefined })]);
	assert.equal(cacheStatus(awaiting, M).basis, "awaiting");
});

test("misses are labelled expired, prefix changed, model changed, TTL changed", () => {
	const ledger = buildLedger([
		real(0, 0, 100_000),
		real(M, 100_000, 1_000),
		real(2 * M, 10_000, 91_000), // still warm: prefix changed
		real(20 * M, 0, 101_000), // after 18 minutes: expired
		real(21 * M, 0, 101_000, { model: "pantheon/claude-sonnet-5-5" }),
		real(22 * M, 0, 101_000, { model: "pantheon/claude-sonnet-5-5", requested: "1h", creation: { fiveMinute: 0, oneHour: 101_000 } }),
	]);
	assert.deepEqual(
		ledger.samples.map((s) => s.miss),
		[undefined, undefined, "prefix changed", "expired", "model changed", "TTL changed"],
	);
	const misses = recentMisses(ledger, 22 * M);
	assert.equal(misses.total, 3); // the 2-minute one is older than 15 minutes
});

test("keepalives extend the countdown, are excluded from the hit rate, and reset on a real request", () => {
	const ledger = buildLedger([real(0, 0, 100_000), keepalive(4.5 * M, 100_000), keepalive(9 * M, 100_000)]);
	assert.equal(ledger.keepalives.length, 2);
	assert.equal(ledger.recent.length, 1);
	assert.equal(cacheStatus(ledger, 10 * M).leftMs, 4 * M);
	const after = buildLedger([...ledger.samples, real(10 * M, 100_000, 500)]);
	assert.equal(after.keepalives.length, 0);
	assert.equal(after.samples.at(-1)!.miss, undefined);
});

test("a compaction stops the countdown until the next request and is not a miss base", () => {
	const ledger = buildLedger([
		real(0, 0, 300_000),
		{ id: "c1", kind: "compaction", model: "x/y", startedAt: 4 * M, read: 0, write: 0, fresh: 300_000, output: 4_000, tokensBefore: 300_000, tokensAfter: 18_000 },
	]);
	const s = cacheStatus(ledger, 5 * M);
	assert.equal(s.state, "compacted");
	assert.deepEqual(s.compacted, { before: 300_000, after: 18_000 });
	const next = buildLedger([...ledger.samples, real(20 * M, 0, 20_000)]);
	assert.equal(next.samples.at(-1)!.miss, undefined);
	assert.equal(cacheStatus(next, 21 * M).state, "warm");
});

test("default keepalive budget: keep warming while cheaper than rewriting the cache", () => {
	const table = anthropicPrices("claude-opus-5-5")!; // 4 / 20 / 0.2 / 5 / 8
	assert.ok(Math.abs(table.read - 0.05) < 1e-9 && Math.abs(table.fiveMinute! - 1.25) < 1e-9 && table.oneHour === 2);
	const ledger = buildLedger([real(0, 0, 200_000)]);
	assert.equal(keepalivesLeft(ledger, table), 23); // reserve one output token as well as cache reads
	const registry = registryPrices({ api: "anthropic-messages", provider: "pantheon", id: "claude-opus-5-5", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })!;
	assert.equal(keepalivesLeft(ledger, registry), 11); // (1.25 - 0.1) / 0.1
	// on a 1h cache the rewrite is priced at the 1h write price (2×)
	assert.equal(keepalivesLeft(ledger, registry, undefined, true), 18);
	// a numeric limit ignores prices; infinite never runs out
	const warmed = buildLedger([real(0, 0, 200_000), keepalive(M, 200_000), keepalive(2 * M, 200_000)]);
	assert.equal(keepalivesLeft(warmed, null, 12), 10);
	assert.equal(keepalivesLeft(warmed, null, Infinity), Infinity);
	assert.equal(keepalivesLeft(warmed, null), 0); // no price → no keepalives with the default limit
	assert.equal(keepalivesLeft(buildLedger([]), table), null);
});

test("grades follow uncached tokens relative to context size", () => {
	assert.equal(cacheGrade({ read: 9_000, write: 1_000, fresh: 0 }), "good"); // 90% on 10k
	assert.equal(cacheGrade({ read: 891_000, write: 99_000, fresh: 0 }), "poor"); // 90% on 990k
	assert.equal(cacheGrade({ read: 240_000, write: 30_000, fresh: 0 }), "fair");
});

test("usage parsing and settings values", () => {
	assert.deepEqual(
		reportedCreation({ cache_creation_input_tokens: 25147, cache_creation: { ephemeral_5m_input_tokens: 25147, ephemeral_1h_input_tokens: 0 } }),
		{ fiveMinute: 25147, oneHour: 0 },
	);
	assert.equal(reportedCreation({ cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }), undefined);
	assert.equal(parseTokens("100k"), 100_000);
	assert.equal(parseTokens("1m"), 1_000_000);
	assert.equal(parseTokens("60000"), 60_000);
	assert.equal(parseTokens("lots"), undefined);
	assert.equal(parseLimit("infinite"), Infinity);
	assert.equal(parseLimit("12"), 12);
	assert.equal(parseLimit("default"), undefined);
});

test("model names match their own listing only", () => {
	for (const name of ["claude-opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5@default", "anthropic/claude-opus-5.5"])
		assert.equal(modelKey(name), "opus:5.5", name);
	assert.equal(anthropicPrices("claude-opus-5-6"), null);
	assert.ok(anthropicPrices("claude-haiku-4-5-20251001"));
	assert.equal(anthropicPrices("my-gateway-alias"), null);
});
