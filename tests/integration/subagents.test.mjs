import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./runtime-fixture.mjs', import.meta.url));
for (const mode of ['foreground', 'background']) {
  test(`real pi-subagents ${mode} runtime`, { timeout: 75_000 }, async t => {
    // Never inherit credentials, NODE_OPTIONS, or the caller's agent directory.
    const env = { PATH: process.env.PATH };
    for (const key of ['PI_KEEPALIVE_PI_ROOT', 'PI_KEEPALIVE_SUBAGENTS_ROOT', 'SystemRoot']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const run = spawnSync(process.execPath, [fixture, mode], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 });
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const line = run.stdout.split('\n').find(l => l.startsWith('KEEPALIVE_INTEGRATION_RESULT '));
    assert.ok(line, 'runtime fixture must emit its evidence report');
    const result = JSON.parse(line.slice('KEEPALIVE_INTEGRATION_RESULT '.length));
    await t.test('correct process role and native extension loading', () => {
      assert.equal(result.mode, mode);
      assert.notEqual(result.pid, process.pid); // fixture isolation; foreground parent and children coexist inside it
      assert.equal(result.marker, mode === 'background' ? '1' : null);
    });
    await t.test('distinct child sessions and no inherited parent upkeep', () => {
      assert.equal(result.distinctSessions, true);
      assert.equal(result.parentWarm, 0);
    });
    await t.test('subagent TTL and byte-identical prefix cache hits', () => {
      assert.equal(result.childTTL, true);
      assert.equal(result.prefixHits, true);
    });
    await t.test('per-child budgets reset only on that child\'s real turn', () => {
      assert.equal(result.childAReal, 2);
      assert.equal(result.childAWarm, 2);
      assert.equal(result.childBWarm, 1);
    });
    await t.test('shutdown aborts in-flight provider traffic and prevents late ledger writes', () => {
      assert.equal(result.abortedOnShutdown, true);
    });
    await t.test('real SDK compaction happens once after the budget, then stops', () => {
      assert.equal(result.childCompactions, 1);
    });
  });
}
