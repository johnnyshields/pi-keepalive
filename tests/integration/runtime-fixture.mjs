// Real pi + pi-subagents runtime exercise. No host shims or live-provider credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

const mode = process.argv[2];
assert.ok(['foreground', 'background'].includes(mode));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
function packageRoot(name, override, specifier) {
  if (override) {
    assert.equal(JSON.parse(readFileSync(join(override, 'package.json'), 'utf8')).name, name);
    return resolve(override);
  }
  let dir;
  try { dir = dirname(require.resolve(specifier)); }
  catch { throw new Error(`Install integration dependencies or set PI_KEEPALIVE_PI_ROOT and PI_KEEPALIVE_SUBAGENTS_ROOT (${name} missing)`); }
  while (dirname(dir) !== dir) {
    try { if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir; } catch {}
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate ${name}`);
}
const piRoot = packageRoot('@earendil-works/pi-coding-agent', process.env.PI_KEEPALIVE_PI_ROOT, '@earendil-works/pi-coding-agent');
const subagentsRoot = packageRoot('pi-subagents', process.env.PI_KEEPALIVE_SUBAGENTS_ROOT, 'pi-subagents/child-tool-plan');
// Pi normally supplies these peers through its loader. Resolve the real host modules,
// rather than shimming them, when testing an installation with suppressed peer copies.
const hostRequire = createRequire(join(piRoot, 'package.json'));
const hostPeers = ['typebox', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui', '@earendil-works/pi-agent-core'];
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (!hostPeers.some(p => specifier === p || specifier.startsWith(p + '/'))) throw error;
    return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true };
  }
} });
const root = mkdtempSync(join(tmpdir(), 'pi-keepalive-real-runtime-'));
const cwd = join(root, 'workspace');
mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = '1';
process.env.HOME = root;
delete process.env.PI_CACHE_RETENTION;
if (mode === 'background') process.env.PI_SUBAGENT_CHILD = '1';
else delete process.env.PI_SUBAGENT_CHILD;
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;
const calls = [];
const cache = new Map();
let holdWarm = false;
let closedWarm = 0;
const held = [];
const errors = [];
let requestId = 0;

function controls(payload) {
  return [payload.cache_control, ...(payload.system ?? []).map(b => b.cache_control),
    ...payload.messages.flatMap(m => Array.isArray(m.content) ? m.content.map(b => b.cache_control) : [])].filter(Boolean);
}
function label(payload) {
  const user = payload.messages.findLast(m => m.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(b => b.text ?? '').join(' ');
  return text.match(/PARENT|CHILD-A|CHILD-B/)?.[0] ?? 'unknown';
}
function prefix(payload) {
  const copy = structuredClone(payload);
  delete copy.max_tokens;
  return JSON.stringify(copy);
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.match(new URL(req.url, 'http://fixture.invalid').pathname, /\/messages$/);
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const key = prefix(body);
    const markers = controls(body);
    const ttl = markers.length && markers.every(c => c.ttl === '1h') ? '1h' : '5m';
    const warm = body.max_tokens === 1;
    const hit = cache.has(key) && clock < cache.get(key);
    if (warm) assert.ok(hit, 'a keepalive must replay a warm, byte-identical prefix');
    const call = { label: label(body), ttl, warm, hit, at: clock };
    calls.push(call);
    cache.set(key, clock + (ttl === '1h' ? 3_600_000 : 300_000));
    const tokens = 10_000;
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: hit ? tokens : 0,
      cache_creation_input_tokens: hit ? 0 : tokens,
      cache_creation: { ephemeral_5m_input_tokens: !hit && ttl === '5m' ? tokens : 0,
        ephemeral_1h_input_tokens: !hit && ttl === '1h' ? tokens : 0 } };
    const message = { id: `msg_fixture_${++requestId}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage };
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const respond = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    };
    if (warm && holdWarm) {
      held.push(respond);
      res.on('close', () => { closedWarm++; });
    } else respond();
  } catch (error) {
    errors.push(error.stack ?? String(error));
    res.writeHead(500); res.end('fixture assertion failed');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, origin, `integration tests forbid external network traffic: ${url.origin}`);
  return originalFetch(input, options);
};

const provider = { baseUrl: origin, api: 'anthropic-messages', apiKey: 'TEST_ONLY_NOT_A_REAL_KEY',
  models: [{ id: 'claude-sonnet-4-5', name: 'Local fixture', reasoning: false, input: ['text'],
    contextWindow: 200_000, maxTokens: 4096, promptCache: { short: 300, long: 3600 },
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }] };
writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { 'keepalive-test': provider } }));
writeFileSync(join(root, 'settings.json'), JSON.stringify({
  defaultProvider: 'keepalive-test', defaultModel: 'claude-sonnet-4-5', cacheWarming: 'off',
  retry: { enabled: false }, compaction: { enabled: false },
  keepalive: { cache_ttl: '5m', subagent_cache_ttl: '1h', cache_upkeep: 'warmcomp', keepalive_limit: '1',
    compact_threshold: '100k', models_dev: false, show_bar: false },
}));
if (mode === 'background') {
  const installed = join(root, 'extensions', 'keepalive');
  mkdirSync(installed, { recursive: true });
  for (const name of ['index.ts', 'child.ts', 'cache.ts', 'prices.ts', 'settings.ts', 'ui.ts', 'package.json']) cpSync(join(repo, name), join(installed, name));
}
let factory, parent, a, b, c;
const extensionErrors = [];
const sampleEntries = child => readFileSync(child.sessionFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(e => e.type === 'custom' && e.customType === 'keepalive-sample').map(e => e.data);
const ownSamples = child => sampleEntries(child).filter(e => e.ownerSession === child.sessionId);
const warms = name => calls.filter(c => c.label === name && c.warm);
async function waitFor(condition, description) {
  const deadline = originalNow() + 6000;
  while (!condition()) {
    if (errors.length || extensionErrors.length) throw new Error([...errors, ...extensionErrors].join('\n'));
    if (originalNow() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
function forkFile(store, name) {
  const path = join(root, `${name}.jsonl`);
  const header = { ...store.getHeader(), id: randomUUID(), parentSession: store.getSessionFile() };
  writeFileSync(path, [header, ...store.getEntries()].map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}
try {
  const pi = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
  const { createDefaultChildSessionFactory } = await import(pathToFileURL(join(subagentsRoot, 'src/runs/shared/child-session.js')).href);
  factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
  let seed;
  let parentRuntime;
  if (mode === 'foreground') {
    parentRuntime = await pi.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'),
      modelsStorePath: join(root, 'models-store.json'), refreshOnCreate: false });
    const store = pi.SessionManager.create(cwd, join(root, 'parent-sessions'));
    store.appendCustomEntry('keepalive-state', { mode: 'off', ttl: '5m', ownerSession: store.getSessionId() });
    const settings = pi.SettingsManager.create(cwd, root, { projectTrusted: false });
    const loader = new pi.DefaultResourceLoader({ cwd, agentDir: root, settingsManager: settings, noExtensions: true,
      additionalExtensionPaths: [join(repo, 'index.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session: parent } = await pi.createAgentSession({ cwd, agentDir: root, modelRuntime: parentRuntime,
      model: parentRuntime.getModel('keepalive-test', 'claude-sonnet-4-5'), thinkingLevel: 'off',
      tools: [], resourceLoader: loader, settingsManager: settings, sessionManager: store }));
    await parent.bindExtensions({ mode: 'print', onError: e => extensionErrors.push(String(e.error)) });
    await parent.prompt('PARENT');
    const reply = parent.messages.findLast(m => m.role === 'assistant');
    assert.equal(reply?.stopReason, 'stop', [...errors, reply?.errorMessage].filter(Boolean).join('\n'));
    assert.equal(calls.at(-1)?.ttl, '5m');
    seed = store;
  } else {
    seed = pi.SessionManager.inMemory(cwd);
    seed.appendMessage({ role: 'user', content: 'PARENT', timestamp: clock });
    seed.appendCustomEntry('keepalive-state', { mode: 'off', ttl: '5m', ownerSession: seed.getSessionId() });
    seed.appendCustomEntry('keepalive-sample', { id: 'parent-observation', kind: 'real', ownerSession: seed.getSessionId(),
      model: 'keepalive-test/claude-sonnet-4-5', startedAt: clock, read: 0, write: 10_000, fresh: 0, output: 1,
      creation: { fiveMinute: 10_000, oneHour: 0 }, requested: '5m' });
  }
  const launch = name => ({ cwd, projectTrusted: false, storage: { kind: 'file', sessionFile: forkFile(seed, name) },
    ...(parentRuntime ? { parentProviderRegistry: parentRuntime } : {}), model: 'keepalive-test/claude-sonnet-4-5:off', tools: [],
    extensionPaths: mode === 'foreground' ? [join(repo, 'child.ts')] : [], ambientExtensions: mode === 'background',
    hooks: [], noSkills: true, noContextFiles: true, runtime: {},
    onExtensionError: e => extensionErrors.push(`${e.event}: ${e.error}`) });
  a = await factory.create(launch('a'));
  b = await factory.create(launch('b'));
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(process.env.PI_SUBAGENT_CHILD, mode === 'background' ? '1' : undefined);
  await Promise.all([a.prompt('CHILD-A'), b.prompt('CHILD-B')]);
  assert.ok(calls.filter(c => c.label.startsWith('CHILD') && !c.warm).every(c => c.ttl === '1h'));
  assert.ok(sampleEntries(a).some(e => e.ownerSession === seed.getSessionId())); // real forked parent history
  clock += 3_570_000;
  await waitFor(() => ownSamples(a).filter(e => e.kind === 'keepalive').length === 1 &&
    ownSamples(b).filter(e => e.kind === 'keepalive').length === 1, 'both children warming with independent ledgers');
  assert.equal(warms('PARENT').length, 0);
  assert.ok([...warms('CHILD-A'), ...warms('CHILD-B')].every(c => c.ttl === '1h' && c.hit));
  assert.equal(a.messages.filter(m => m.role === 'user').length, 2); // parent + child, no synthetic warm turn
  clock += 3_570_000;
  await new Promise(r => setTimeout(r, 1200)); // allow at least one real scheduler tick at the exhausted budget
  assert.equal(warms('CHILD-A').length, 1);
  assert.equal(warms('CHILD-B').length, 1);
  await a.prompt('CHILD-A next real turn');
  clock += 3_570_000;
  await waitFor(() => ownSamples(a).filter(e => e.kind === 'keepalive').length === 2, 'only A resets its budget');
  assert.equal(warms('CHILD-B').length, 1);
  const aFile = a.sessionFile;
  const aBytes = readFileSync(aFile, 'utf8');
  await a.dispose();
  await b.prompt('CHILD-B next real turn');
  holdWarm = true;
  clock += 3_570_000;
  await waitFor(() => held.length === 1, 'B warm request held in flight');
  const before = ownSamples(b).filter(e => e.kind === 'keepalive').length;
  await b.dispose();
  await waitFor(() => closedWarm > 0, 'shutdown aborts the background HTTP request');
  for (const respond of held) respond();
  assert.equal(ownSamples(b).filter(e => e.kind === 'keepalive').length, before);
  assert.equal(readFileSync(aFile, 'utf8'), aBytes, 'disposing A prevents subsequent ledger writes');
  // Exercise the real SDK compaction path, not a stubbed ctx.compact callback.
  holdWarm = false;
  const settingsPath = join(root, 'settings.json');
  const configured = JSON.parse(readFileSync(settingsPath, 'utf8'));
  configured.compaction.keepRecentTokens = 100;
  configured.keepalive.keepalive_limit = '0';
  configured.keepalive.compact_threshold = '1k';
  writeFileSync(settingsPath, JSON.stringify(configured));
  seed.appendMessage({ role: 'user', content: 'Old context ' + 'historical data '.repeat(4000), timestamp: clock });
  seed.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Old reply' }], api: 'anthropic-messages',
    provider: 'keepalive-test', model: 'claude-sonnet-4-5', stopReason: 'stop', timestamp: clock,
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 10_000, totalTokens: 10_001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  c = await factory.create(launch('c'));
  await c.prompt('CHILD-C compaction check');
  assert.ok(ownSamples(c).filter(e => e.kind === 'real').every(e => e.requested === '1h'));
  clock += 3_570_000;
  await waitFor(() => ownSamples(c).some(e => e.kind === 'compaction'), 'real child compaction after its zero keepalive budget');
  const compactions = ownSamples(c).filter(e => e.kind === 'compaction').length;
  clock += 3_570_000;
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(ownSamples(c).filter(e => e.kind === 'compaction').length, compactions);
  assert.equal(compactions, 1);
  await c.dispose();
  assert.deepEqual(errors, []);
  assert.deepEqual(extensionErrors, []);
  console.log('KEEPALIVE_INTEGRATION_RESULT ' + JSON.stringify({ mode, pid: process.pid, marker: process.env.PI_SUBAGENT_CHILD ?? null,
    distinctSessions: a.sessionId !== b.sessionId, childAReal: ownSamples(a).filter(e => e.kind === 'real').length,
    childAWarm: ownSamples(a).filter(e => e.kind === 'keepalive').length, childBWarm: before,
    parentWarm: warms('PARENT').length, prefixHits: calls.filter(c => c.warm).every(c => c.hit),
    childTTL: calls.filter(c => c.label.startsWith('CHILD')).every(c => c.ttl === '1h'), abortedOnShutdown: closedWarm > 0,
    childCompactions: compactions }));
} finally {
  try {
    await factory?.dispose();
    if (parent) {
      try { await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
      finally { parent.dispose(); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}
