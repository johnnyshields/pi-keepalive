import "./host.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { DEFAULTS, loadSettings, saveSettings } = await import("../settings.ts");

function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-keepalive-settings-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const project = join(root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, project, file: join(root, "settings.json"), projectFile: join(project, ".pi", "settings.json") };
}

test("defaults, invalid values and trust-gated project overrides", (t) => {
	const { project, file, projectFile } = setup(t);
	assert.deepEqual(loadSettings(project), DEFAULTS);
	writeFileSync(file, JSON.stringify({ keepalive: { cache_upkeep: "warm", show_bar: false, keepalive_limit: -1, compact_threshold: "oops" } }));
	writeFileSync(projectFile, JSON.stringify({ keepalive: { cache_upkeep: "warmcomp", keepalive_limit: "3", cache_ttl: "1h" } }));
	assert.equal(loadSettings(project).cache_upkeep, "warm");
	assert.equal(loadSettings(project).keepalive_limit, "default");
	assert.equal(loadSettings(project, true).cache_upkeep, "warmcomp");
	assert.equal(loadSettings(project, true).keepalive_limit, "3");
	assert.equal(loadSettings(project, true).show_bar, false);
});

test("saving preserves unrelated fields and private file permissions", (t) => {
	const { project, root, file } = setup(t);
	writeFileSync(file, JSON.stringify({ unrelated: { value: "preserve" }, keepalive: { future_option: 42 } }), { mode: 0o600 });
	chmodSync(file, 0o600);
	assert.equal(saveSettings(project, { cache_upkeep: "warm" }), file);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { unrelated: { value: "preserve" }, keepalive: { future_option: 42, cache_upkeep: "warm" } });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(readdirSync(root).some((f) => f.endsWith(".tmp")), false);
});

test("new settings files are private; only normalized patch keys are saved", (t) => {
	const { project, file } = setup(t);
	saveSettings(project, { cache_upkeep: "invalid", keepalive_limit: "-1", show_bar: false, injected: true } as any);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { keepalive: { show_bar: false } });
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("malformed JSON is never overwritten and malformed keepalive objects recover", (t) => {
	const { project, file } = setup(t);
	for (const content of ["not json", "[]", "null"]) {
		writeFileSync(file, content);
		assert.equal(saveSettings(project, { show_bar: false }), null);
		assert.equal(readFileSync(file, "utf8"), content);
		assert.deepEqual(loadSettings(project), DEFAULTS);
	}
	writeFileSync(file, '{"keepalive":"broken"}');
	saveSettings(project, { keepalive_limit: "0" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).keepalive, { keepalive_limit: "0" });
});

test("saves use a project only when trusted and already configured", (t) => {
	const { project, file, projectFile } = setup(t);
	writeFileSync(projectFile, '{"keepalive":{"cache_upkeep":"warm"}}');
	assert.equal(saveSettings(project, { show_bar: false }), file);
	assert.equal(saveSettings(project, { show_bar: true }, true), projectFile);
	assert.equal(JSON.parse(readFileSync(projectFile, "utf8")).keepalive.cache_upkeep, "warm");
});
