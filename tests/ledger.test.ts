import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLedger, cacheStatus, keepalivesLeft, validSample, type Sample } from "../cache.ts";

const sample = (extra: Partial<Sample> = {}): Sample => ({
	id: "real", kind: "real", model: "a/b", startedAt: 1000,
	read: 10_000, write: 0, fresh: 0, output: 1, declaredTtlMs: 300_000, ...extra,
});

test("arbitrary declared lifetimes are usable, not just 5m and 1h", () => {
	const s = cacheStatus(buildLedger([sample({ declaredTtlMs: 600_000 })]), 61_000);
	assert.equal(s.ttl, "10m");
	assert.equal(s.basis, "declared");
	assert.equal(s.leftMs, 540_000);
});

test("cache metadata resets on model changes and compactions", () => {
	const long = sample({ read: 0, write: 10_000, creation: { fiveMinute: 0, oneHour: 10_000 } });
	const next = sample({ id: "next", startedAt: 2000, model: "a/c" });
	assert.equal(cacheStatus(buildLedger([long, next]), 3000).ttl, "5m");
	const compact = sample({ id: "compact", kind: "compaction", startedAt: 2000 });
	const after = sample({ id: "after", startedAt: 3000 });
	assert.equal(cacheStatus(buildLedger([long, compact, after]), 4000).ttl, "5m");
});

test("a keepalive write updates the observed TTL; a read-only TTL toggle does not", () => {
	const original = sample({ write: 10_000, read: 0, creation: { fiveMinute: 10_000, oneHour: 0 } });
	const read = sample({ id: "read", kind: "keepalive", startedAt: 2000, requested: "1h" });
	assert.equal(cacheStatus(buildLedger([original, read]), 3000).ttl, "5m");
	const write = sample({ id: "write", kind: "keepalive", startedAt: 3000, read: 0, write: 10_000, creation: { fiveMinute: 0, oneHour: 10_000 } });
	assert.equal(cacheStatus(buildLedger([original, read, write]), 4000).ttl, "1h");
});

test("mixed caches expire conservatively at the short TTL", () => {
	const mixed = sample({ read: 0, write: 10_000, creation: { fiveMinute: 1000, oneHour: 9000 } });
	assert.equal(cacheStatus(buildLedger([mixed]), 301_000).state, "expired");
});

test("optional session metadata must be finite nonnegative safe integers", () => {
	for (const field of ["declaredTtlMs", "tokensBefore", "tokensAfter"]) {
		for (const value of [NaN, Infinity, -1, 1.5, "300000"]) assert.equal(validSample(sample({ [field]: value })), false, `${field}=${value}`);
	}
	assert.equal(validSample(sample({ declaredTtlMs: 0 })), false);
});

test("duplicate ids count once; expiry equality is a miss", () => {
	const first = sample();
	const second = sample({ id: "second", startedAt: 301_000, read: 0, write: 10_000 });
	const ledger = buildLedger([second, first, first]);
	assert.equal(ledger.totals.requests, 2);
	assert.equal(ledger.samples[1].miss, "expired");
});

test("budgets reject malformed numeric limits and reserve output cost", () => {
	const ledger = buildLedger([sample({ read: 1, write: 0 })]);
	for (const limit of [NaN, -1, 1.5]) assert.equal(keepalivesLeft(ledger, null, limit), 0);
	assert.equal(keepalivesLeft(ledger, { read: 0.1, output: 5, fiveMinute: 1.25 }), 0);
});
