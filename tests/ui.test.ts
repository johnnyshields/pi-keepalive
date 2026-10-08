import "./host.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLedger, cacheStatus } from "../cache.ts";
const { Dashboard, renderBar } = await import("../ui.ts");

const theme: any = { appearance: "dark", fg: (_tone: any, text: string) => text, style: (text: string) => text };
const ledger = buildLedger([]);
const view: any = {
	now: 0, ledger, status: cacheStatus(ledger, 0), mode: "off",
	ttl: { value: "5m", supported: true, chosen: false, source: "default" },
	left: null, threshold: 100_000, leadMs: 30_000,
	pricesPending: false, replay: { ok: false }, pending: false, piWarming: "off", notes: [],
};

test("narrow bars have no clickable regions beyond the visible text", () => {
	for (const width of [0, 1, 4, 8, 20, 80]) {
		const result = renderBar(theme, view, width);
		assert.ok(Array.from(result.line).length <= width);
		assert.ok(result.segments.every((s) => s.from >= 0 && s.from < s.to && s.to <= width));
	}
});

test("upkeep labels use a spaced keepalive count and comp, including infinity", () => {
	const warm = { ...view, mode: "warmcomp", left: 8, compactable: true, replay: { ok: true }, status: { ...view.status, state: "warm" } };
	const line = renderBar(theme, warm, 200).line;
	assert.ok(line.includes("↻ 8 ➜ comp"), line);
	assert.equal(line.includes("cmpt"), false);
	assert.ok(renderBar(theme, { ...warm, left: Infinity }, 200).line.includes("↻ ∞"));
	assert.ok(renderBar(theme, { ...view, status: { ...view.status, state: "compacted", compacted: { before: 100_000, after: 10_000 } } }, 200).line.includes("comp ✓"));
});

test("dashboard respects narrow terminal widths and keyboard controls", () => {
	let closes = 0, modes = 0, ttls = 0;
	const dashboard = new Dashboard(theme, () => view, { close: () => { closes++; }, cycleMode: () => { modes++; }, toggleTtl: () => { ttls++; }, render: () => {} });
	for (const width of [0, 1, 3, 4, 10, 80]) assert.ok(dashboard.render(width).every((line) => Array.from(line).length <= width), `width=${width}`);
	dashboard.handleInput("m"); dashboard.handleInput("t"); dashboard.handleInput("q"); dashboard.handleInput("\t");
	assert.deepEqual([modes, ttls, closes], [1, 1, 1]);
	assert.equal(dashboard.filter, "real");
});
