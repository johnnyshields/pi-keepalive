import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookUpPrices, matchPrices, modelsDevCatalog, priceIndex, registryPrices, sampleCost } from "../prices.ts";

const model = { provider: "test", id: "custom-family-1", api: "anthropic-messages", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const row = ["test", "custom-family-1", null, 3, 15, 0.3, 3.75, null];
const rootFor = (t: TestContext) => {
	const root = mkdtempSync(join(tmpdir(), "pi-keepalive-prices-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
};

test("registry pricing handles unordered context tiers and rejects invalid tiers", () => {
	const tiers = [
		{ inputTokensAbove: 100, input: 0, output: 10, cacheRead: 1 },
		{ inputTokensAbove: 200, input: 6, output: 30, cacheRead: 3, cacheWrite: 7.5 },
		{ inputTokensAbove: 50, input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
	];
	const tiered = { ...model, cost: { ...model.cost, tiers } };
	assert.ok(Math.abs(registryPrices(tiered, 50)!.read - 0.1) < 1e-12);
	assert.ok(Math.abs(registryPrices(tiered, 100)!.read - 0.2) < 1e-12);
	assert.equal(registryPrices(tiered, 201)?.read, 0.5);
	assert.ok(Math.abs(registryPrices({ ...model, cost: { ...model.cost, tiers: "invalid" } })!.read - 0.1) < 1e-12);
	assert.equal(registryPrices({ ...model, cost: { input: NaN } }), null);
});

test("registry and table lookups avoid network; missing offline prices stay unknown", async (t) => {
	const root = rootFor(t);
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
	assert.equal((await lookUpPrices(model, { root, allowNetwork: true }))?.source, "pi model registry");
	assert.match((await lookUpPrices({ id: "claude-sonnet-4-5" }, { root, allowNetwork: true }))?.source ?? "", /^Anthropic/);
	assert.equal(await lookUpPrices({ id: "unknown-1" }, { root, allowNetwork: false }), null);
	assert.equal(fetch.mock.callCount(), 0);
});

test("matching requires family/version agreement and consistent price ratios", () => {
	assert.equal(matchPrices(priceIndex([row]), "custom-family-2"), null);
	const conflicting = [0.1, 0.3, 0.5].map((read, i) => [`p${i}`, "custom-family-1", null, 1, 5, read, 1.25, null]);
	assert.equal(matchPrices(priceIndex(conflicting), "custom-family-1"), null);
	assert.ok(Math.abs(matchPrices(priceIndex([row, ["other", "custom-family-1", null, 3, 15, 0.3, 3.75, null]]), "custom-family-1")!.read - 0.1) < 1e-12);
});

test("models.dev uses cached data offline and revalidates ETags", async (t) => {
	const root = rootFor(t);
	const now = 200_000_000;
	writeFileSync(join(root, "models-dev.json"), JSON.stringify({ entries: [row], fetchedAt: now - 25 * 3_600_000, etag: "etag" }));
	assert.equal((await modelsDevCatalog(root, false, now)).catalog, "stale");
	const fetch = t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
		assert.equal(options.headers["if-none-match"], "etag");
		return new Response(null, { status: 304 });
	});
	assert.equal((await modelsDevCatalog(root, true, now)).catalog, "fresh");
	assert.equal((await modelsDevCatalog(root, true, now + 1000)).index.size, 1);
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(readdirSync(root).some((f) => f.endsWith(".lock") || f.endsWith(".tmp")), false);
});

test("download failures back off, preserve stale entries and clean up leases", async (t) => {
	const root = rootFor(t);
	const now = 200_000_000;
	writeFileSync(join(root, "models-dev.json"), JSON.stringify({ entries: [row], fetchedAt: 1 }));
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response("no", { status: 503 }));
	const first = await modelsDevCatalog(root, true, now);
	assert.equal(first.catalog, "stale");
	assert.equal(first.index.size, 1);
	await modelsDevCatalog(root, true, now + 1000);
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(JSON.parse(readFileSync(join(root, "models-dev.json"), "utf8")).failedAt, now);
	assert.equal(readdirSync(root).some((f) => f.endsWith(".lock") || f.endsWith(".tmp")), false);
});

test("a shared lease prevents concurrent refreshes and stale leases recover", async (t) => {
	const root = rootFor(t);
	const now = 200_000_000;
	writeFileSync(join(root, "models-dev.lock"), String(now));
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ test: { models: { "custom-family-1": { cost: { input: 3, output: 15, cache_read: 0.3 } } } } })));
	await modelsDevCatalog(root, true, now);
	assert.equal(fetch.mock.callCount(), 0);
	await modelsDevCatalog(root, true, now + 121_000);
	assert.equal(fetch.mock.callCount(), 1);
});

test("fresh empty leases are not stolen before their owner writes the timestamp", async (t) => {
	const root = rootFor(t);
	writeFileSync(join(root, "models-dev.lock"), "");
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	await modelsDevCatalog(root, true);
	assert.equal(fetch.mock.callCount(), 0);
});

test("empty or malformed cached listings do not suppress catalog refresh", async (t) => {
	const root = rootFor(t);
	const now = Date.now();
	writeFileSync(join(root, "models-dev.json"), JSON.stringify({ entries: [], fetchedAt: now }));
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ test: { models: { "custom-family-1": { cost: { input: 3, output: 15, cache_read: 0.3 } } } } })));
	assert.equal((await modelsDevCatalog(root, true, now)).catalog, "fresh");
	assert.equal(fetch.mock.callCount(), 1);
});

test("sample spend uses context tiers and one-hour write pricing, never NaN", () => {
	const sample: any = { read: 20_000, write: 1000, fresh: 0, output: 1, creation: { fiveMinute: 0, oneHour: 1000 } };
	const tiered = { ...model, cost: { ...model.cost, tiers: [{ inputTokensAbove: 15_000, input: 6, output: 30, cacheRead: 3, cacheWrite: 7.5 }] } };
	assert.equal(sampleCost(tiered, sample), (20_000 * 3 + 1000 * 12 + 30) / 1e6);
	assert.equal(sampleCost({ cost: {} }, sample), null);
	assert.equal(sampleCost({ ...model, cost: { ...model.cost, cacheWrite: undefined } }, sample), null);
});

test("future-dated caches and malformed JSON cannot suppress refresh forever", async (t) => {
	const root = rootFor(t);
	const now = 200_000_000;
	writeFileSync(join(root, "models-dev.json"), JSON.stringify({ entries: [row], fetchedAt: now + 10_000_000, failedAt: now + 10_000_000 }));
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response("invalid JSON"));
	await modelsDevCatalog(root, true, now);
	assert.equal(fetch.mock.callCount(), 1);
});
