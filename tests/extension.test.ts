import "./host.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: keepalive } = await import("../index.ts");
const { default: childKeepalive } = await import("../child.ts");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

async function harness(t: TestContext, config: Record<string, unknown> = {}, child: boolean | "in-process" = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-keepalive-extension-"));
	const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_CACHE_RETENTION", "PI_OFFLINE"];
	const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_SUBAGENT_CHILD = child === true ? "1" : "0";
	process.env.PI_OFFLINE = "1";
	delete process.env.PI_CACHE_RETENTION;
	mkdirSync(join(root, "project"));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ keepalive: { cache_upkeep: "warm", keepalive_limit: "2", show_bar: false, ...config } }));
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const calls: any[] = [];
	const notices: string[] = [];
	let queued = false;
	let idle = true;
	let defer = false;
	let release: (() => void) | undefined;
	let compactCalls = 0;
	let currentPrefix = 10_000;
	const model: any = {
		provider: "test", id: "claude-sonnet-4-5", api: "anthropic-messages",
		promptCache: { short: 300, long: 3600 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	};
	const c: any = {
		model, thinkingLevel: "off", cwd: join(root, "project"), hasUI: false, mode: "rpc",
		isIdle: () => idle, hasPendingMessages: () => queued, isProjectTrusted: () => false,
		sessionManager: { getBranch: () => entries, getSessionId: () => "session" },
		ui: { notify: (s: string) => notices.push(s) },
		compact: (options: any) => { compactCalls++; options.onError(new Error("test refusal")); },
		modelRegistry: {
			find: (provider: string, id: string) => provider === c.model.provider && id === c.model.id ? c.model : undefined,
			streamSimple: (_model: any, _context: any, options: any) => {
				const payload = options.onPayload();
				calls.push({ payload, options });
				const openai = _model.api !== "anthropic-messages";
				if (!openai) options.onProviderStreamEvent({ type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: currentPrefix, cache_creation_input_tokens: 0, output_tokens: 1 } } });
				const reply = () => {
					if (openai) options.onProviderStreamEvent({ type: "response.completed", response: { usage: { input_tokens: currentPrefix + 25,
						input_tokens_details: { cached_tokens: currentPrefix, cache_write_tokens: 20 }, output_tokens: 8 } } });
					return {};
				};
				return { result: () => defer ? new Promise((r) => { release = () => r(reply()); }) : Promise.resolve(reply()) };
			},
		},
	};
	(child === "in-process" ? childKeepalive : keepalive)({
		on: (name: string, fn: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: () => {}, getSettings: () => ({ cacheWarming: "idle" }),
	} as any);
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const fn of handlers.get(name) ?? []) result = await fn(event, c);
		return result;
	};
	t.after(async () => {
		await emit("session_shutdown");
		release?.();
		await flush();
		for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
		rmSync(root, { recursive: true, force: true });
	});
	await emit("session_start");
	const raw = (data: any, route = c.model) => emit("provider_stream_event", { data, provider: route.provider, model: route.id, api: route.api });
	let responseId = 0;
	const real = async (payloadPatch: any = {}, tokens = 10_000) => {
		currentPrefix = tokens;
		await emit("agent_start");
		const payload: any = { model: c.model.id, max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }], ...payloadPatch };
		await emit("before_provider_request", { payload });
		const long = payload.messages[0]?.content[0]?.cache_control?.ttl === "1h";
		await raw({ type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: tokens, cache_creation: { ephemeral_5m_input_tokens: long ? 0 : tokens, ephemeral_1h_input_tokens: long ? tokens : 0 } } } });
		await emit("message_end", { message: { role: "assistant", provider: c.model.provider, model: c.model.id, api: c.model.api, responseId: String(++responseId), usage: { input: 0, cacheRead: 0, cacheWrite: tokens, output: 1 } } });
		await emit("agent_settled");
		return payload;
	};
	return {
		c, calls, entries, emit, raw, real, commands, notices,
		tick: async (ms: number) => { t.mock.timers.tick(ms); await flush(); },
		queued: (v: boolean) => { queued = v; }, idle: (v: boolean) => { idle = v; },
		defer: () => { defer = true; }, release: async () => { release?.(); await flush(); },
		compactions: () => compactCalls,
	};
}

for (const child of [false, "in-process"] as const) {
	test(`warmcomp is the default for new ${child ? "child" : "main"} sessions`, async (t) => {
		const h = await harness(t, { cache_upkeep: undefined, keepalive_limit: "0", compact_threshold: "1k" }, child);
		await h.real();
		await h.tick(270_000);
		assert.equal(h.compactions(), 1);
	});
}

test("explicit off settings and saved session overrides survive the new default", async (t) => {
	const h = await harness(t, { cache_upkeep: "off", compact_threshold: "1k" });
	await h.real();
	await h.tick(270_000);
	assert.equal(h.compactions(), 0);
	assert.equal(h.calls.length, 0);
	h.entries.push({ type: "custom", customType: "keepalive-state", data: { mode: "off", ttl: null, ownerSession: "session" } });
	writeFileSync(join(h.c.cwd, "..", "settings.json"), JSON.stringify({ keepalive: { cache_upkeep: "warmcomp", show_bar: false } }));
	await h.emit("session_start");
	await h.commands.get("keepalive").handler("status", h.c);
	assert.ok(h.notices.at(-1)?.includes("upkeep off"));
});

test("idle warming replays the exact prefix and stops at the numeric budget", async (t) => {
	const h = await harness(t);
	const original = await h.real({ tools: [{ name: "test", input_schema: { type: "object" } }] });
	await h.tick(270_000);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0].payload.messages, original.messages);
	assert.deepEqual(h.calls[0].payload.tools, original.tools);
	assert.equal(h.calls[0].payload.max_tokens, 1);
	assert.equal(original.max_tokens, 4096);
	await h.tick(270_000);
	await h.tick(270_000);
	assert.equal(h.calls.length, 2);
});

test("queued work, active turns and expired timers cannot send keepalives", async (t) => {
	const h = await harness(t);
	await h.real();
	h.queued(true);
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
	h.queued(false);
	await h.emit("agent_start");
	await h.tick(31_000);
	await h.emit("agent_settled");
	await h.tick(1000);
	assert.equal(h.calls.length, 0);
});

test("subagents inherit full upkeep and use their separate TTL", async (t) => {
	const h = await harness(t, { subagent_cache_ttl: "1h" }, true);
	const payload = await h.real();
	assert.equal(payload.messages[0].content[0].cache_control.ttl, "1h");
	assert.deepEqual(await h.emit("cache_warming_decision"), { action: "stop" });
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
	await h.tick(3_300_000);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].payload.messages[0].content[0].cache_control.ttl, "1h");
});

test("in-process subagents use the child entry point without environment mutation", async (t) => {
	const h = await harness(t, { cache_ttl: "5m", subagent_cache_ttl: "1h" }, "in-process");
	const payload = await h.real();
	assert.equal(process.env.PI_SUBAGENT_CHILD, "0");
	assert.equal(payload.messages[0].content[0].cache_control.ttl, "1h");
	await h.tick(3_570_000);
	assert.equal(h.calls.length, 1);
});

test("forked child contexts do not inherit parent cache ledgers or TTL/mode overrides", async (t) => {
	const h = await harness(t, { cache_upkeep: "warmcomp", keepalive_limit: "0", compact_threshold: "1k", subagent_cache_ttl: "1h" }, "in-process");
	h.entries.push(
		{ type: "custom", customType: "keepalive-sample", data: { id: "parent", ownerSession: "parent-session", kind: "real", model: `test/${h.c.model.id}`, startedAt: Date.now(), read: 0, write: 100_000, fresh: 0, output: 1, creation: { fiveMinute: 100_000, oneHour: 0 } } },
		{ type: "custom", customType: "keepalive-state", data: { mode: "off", ttl: "5m", ownerSession: "parent-session" } },
	);
	await h.emit("session_start");
	await h.tick(270_000);
	assert.equal(h.compactions(), 0);
	const payload = await h.real();
	assert.equal(payload.messages[0].content[0].cache_control.ttl, "1h");
	await h.tick(3_570_000);
	assert.equal(h.compactions(), 1);
});

test("subagents can also compact when the warm budget is exhausted", async (t) => {
	const h = await harness(t, { cache_upkeep: "warmcomp", keepalive_limit: "0", compact_threshold: "1k" }, true);
	await h.real();
	await h.tick(270_000);
	await h.tick(10_000);
	assert.equal(h.compactions(), 1);
});

test("late keepalive completions cannot leak across branch/session resets", async (t) => {
	const h = await harness(t);
	await h.real();
	h.defer();
	await h.tick(270_000);
	assert.equal(h.calls.length, 1);
	h.entries.length = 0;
	await h.emit("session_start");
	assert.equal(h.calls[0].options.signal.aborted, true);
	await h.release();
	assert.equal(h.entries.length, 0);
});

test("real turns cancel probes without letting old responses replace the new anchor", async (t) => {
	const h = await harness(t);
	await h.real(); h.defer();
	await h.tick(270_000);
	await h.real();
	assert.equal(h.calls[0].options.signal.aborted, true);
	await h.release();
	assert.equal(h.entries.filter((e) => e.data?.kind === "keepalive").length, 0);
});

test("model/thinking changes invalidate replay even when switched back", async (t) => {
	const h = await harness(t);
	await h.real();
	await h.emit("model_select");
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
	await h.real();
	await h.emit("thinking_level_select");
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
});

test("cache opt-outs and gateway wire aliases are handled safely", async (t) => {
	const h = await harness(t);
	await h.real({ messages: [{ role: "user", content: "no caching" }] });
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
	await h.real({ model: "gateway-wire-alias" });
	await h.tick(270_000);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].payload.model, "gateway-wire-alias");
});

test("budget thinking preserves the budget, uses a legal cap and aborts after usage", async (t) => {
	const h = await harness(t);
	await h.real({ thinking: { type: "enabled", budget_tokens: 8192 } });
	await h.tick(270_000);
	assert.equal(h.calls[0].payload.thinking.budget_tokens, 8192);
	assert.equal(h.calls[0].payload.max_tokens, 8193);
	assert.equal(h.calls[0].options.signal.aborted, true);
	assert.equal(h.entries.filter((e) => e.data?.kind === "keepalive").length, 1);
});

test("manual compaction suppresses upkeep and drops the old payload", async (t) => {
	const h = await harness(t);
	await h.real();
	await h.emit("session_before_compact");
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
	await h.emit("session_compact_failed");
	await h.tick(1000);
	assert.equal(h.calls.length, 0);
});

test("old compaction callbacks cannot mutate a new session", async (t) => {
	const h = await harness(t, { cache_upkeep: "compact", compact_threshold: "1k" });
	let callback: any;
	t.mock.method(h.c, "compact", (options: any) => { callback = options; });
	await h.real();
	await h.tick(270_000);
	assert.ok(callback);
	h.entries.length = 0;
	await h.emit("session_start");
	callback.onError(new Error("stale compaction failure"));
	await h.commands.get("keepalive").handler("status", h.c);
	assert.equal(h.notices.at(-1)?.includes("stale compaction failure"), false);
	await h.real();
	await h.tick(270_000);
	assert.equal(h.c.compact.mock.callCount(), 2);
});

test("long active requests survive the stale-request timeout", async (t) => {
	const h = await harness(t);
	await h.real();
	await h.emit("agent_start");
	await h.emit("before_provider_request", { payload: { model: h.c.model.id, max_tokens: 4096, messages: [] } });
	await h.tick(700_000);
	await h.emit("message_end", { message: { role: "assistant", provider: h.c.model.provider, model: h.c.model.id, responseId: "long", usage: { input: 1234, cacheRead: 0, cacheWrite: 0, output: 5 } } });
	assert.equal(h.entries.at(-1).data.fresh, 1234);
});

for (const change of ["user turn", "queued message", "expiry", "mode off", "shutdown"]) {
	test(`an asynchronous price lookup rechecks safety after ${change}`, async (t) => {
		const h = await harness(t, { keepalive_limit: "default" });
		h.c.model.id = "unknown-family-1";
		h.c.model.cost = {};
		process.env.PI_OFFLINE = "";
		let release!: (value: Response) => void;
		let started!: () => void;
		const fetching = new Promise<void>((r) => { started = r; });
		t.mock.method(globalThis, "fetch", () => { started(); return new Promise<Response>((r) => { release = r; }); });
		await h.real();
		await h.tick(270_000);
		await fetching;
		if (change === "user turn") await h.emit("agent_start");
		if (change === "queued message") h.queued(true);
		if (change === "expiry") await h.tick(31_000);
		if (change === "mode off") await h.commands.get("keepalive").handler("mode off", h.c);
		if (change === "shutdown") await h.emit("session_shutdown");
		release(new Response(JSON.stringify({ test: { models: { "unknown-family-1": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } } })));
		await flush();
		assert.equal(h.calls.length, 0);
	});
}

test("tiered pricing is refreshed when the context crosses the tier boundary", async (t) => {
	const h = await harness(t, { keepalive_limit: "default" });
	h.c.model.cost.tiers = [{ inputTokensAbove: 15_000, input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3.75 }];
	await h.real();
	await h.commands.get("keepalive").handler("status", h.c); // prime lower-tier prices
	await flush();
	await h.real({}, 20_000);
	await h.tick(270_000);
	await h.tick(270_000);
	assert.equal(h.calls.length, 1); // high-tier budget permits one, not eleven
});

test("provider errors and duplicate completion events cannot trigger a billing loop", async (t) => {
	const h = await harness(t);
	await h.real();
	const last = h.entries.at(-1).data;
	await h.emit("message_end", { message: { role: "assistant", provider: "test", model: h.c.model.id, responseId: "1", usage: { input: 0, cacheRead: 0, cacheWrite: 10_000, output: 1 } } });
	assert.equal(h.entries.filter((e) => e.data?.kind === "real").length, 1);
	t.mock.method(h.c.modelRegistry, "streamSimple", () => { throw new Error("offline"); });
	await h.tick(270_000);
	await h.tick(20_000);
	assert.equal(h.entries.at(-1).data, last);
	assert.equal(h.c.modelRegistry.streamSimple.mock.callCount(), 1);
});

test("foreign provider stream events do not contaminate main-request TTL metadata", async (t) => {
	const h = await harness(t);
	await h.emit("agent_start");
	await h.emit("before_provider_request", { payload: { max_tokens: 4096, messages: [], model: h.c.model.id } });
	await h.raw({ type: "message_start", message: { usage: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 } } } }, { ...h.c.model, provider: "foreign" });
	await h.emit("message_end", { message: { role: "assistant", provider: "test", model: h.c.model.id, responseId: "ours", usage: { input: 0, cacheRead: 0, cacheWrite: 100, output: 1 } } });
	assert.equal(h.entries.at(-1).data.creation, undefined);
});

test("failed requests cannot leave a replayable snapshot, even with identical timestamps", async (t) => {
	const h = await harness(t);
	await h.real();
	await h.emit("agent_start");
	await h.emit("before_provider_request", { payload: { model: h.c.model.id, max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: "failed attempt", cache_control: { type: "ephemeral" } }] }] } });
	await h.emit("message_end", { message: { role: "assistant", provider: "test", model: h.c.model.id, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, stopReason: "error" } });
	await h.emit("agent_settled");
	await h.tick(270_000);
	assert.equal(h.calls.length, 0);
});

test("real one-token requests are not mistaken for pi's warmer", async (t) => {
	const h = await harness(t);
	await h.real({ max_tokens: 1 });
	assert.equal(h.entries.at(-1).data.kind, "real");
	await h.tick(270_000);
	assert.equal(h.calls.length, 1);
});

test("native streaming refreshes are identified and accounted separately", async (t) => {
	const h = await harness(t);
	await h.real();
	await h.emit("agent_start");
	assert.equal(await h.emit("cache_warming_decision", { action: "warm", continuationProbability: 1 }), undefined);
	await h.emit("before_provider_request", { payload: { model: h.c.model.id, max_tokens: 1, messages: [] } });
	await h.raw({ type: "message_start", message: { usage: { cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 } } });
	await h.raw({ type: "message_delta", usage: { output_tokens: 1 } });
	assert.equal(h.entries.at(-1).data.via, "pi-warmer");
});

test("TTL rewrites include request-level caching and native schedule mismatches are vetoed", async (t) => {
	const h = await harness(t, { cache_ttl: "1h" });
	const payload = await h.real({ cache_control: { type: "ephemeral" } });
	assert.equal(payload.cache_control.ttl, "1h");
	await h.commands.get("keepalive").handler("mode off", h.c);
	await h.emit("agent_start");
	assert.deepEqual(await h.emit("cache_warming_decision", { action: "warm" }), { action: "stop" });
	process.env.PI_CACHE_RETENTION = "long";
	await h.commands.get("keepalive").handler("ttl 5m", h.c);
	assert.deepEqual(await h.emit("cache_warming_decision", { action: "warm" }), { action: "stop" });
});

async function openAiReal(h: Awaited<ReturnType<typeof harness>>, api: string, patch: any = {}, fresh = 0) {
	Object.assign(h.c.model, { id: "gpt-6-sol", api, promptCache: { short: 300 } }); // stale user metadata must not shorten the horizon
	await h.emit("agent_start");
	const payload: any = { model: "gpt-6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "original question" }] }],
		instructions: "original instructions", reasoning: { effort: "high" }, prompt_cache_key: "stable-session-key",
		tools: [{ type: "function", name: "test", parameters: { type: "object" } }],
		...(api === "openai-responses" ? { max_output_tokens: 4096 } : {}), ...patch };
	await h.emit("before_provider_request", { payload });
	await h.emit("message_end", { message: { role: "assistant", provider: h.c.model.provider, model: h.c.model.id, api,
		responseId: `openai:${Date.now()}`, usage: { input: fresh, cacheRead: 0, cacheWrite: 10_000, output: 1 } } });
	await h.emit("agent_settled");
	return payload;
}

for (const api of ["openai-responses", "openai-codex-responses"]) {
	for (const child of [false, true, "in-process"] as const) {
		for (const mode of ["off", "warm", "compact", "warmcomp"]) {
			test(`${api} ${child || "main"}: ${mode} follows the fixed 30m horizon`, async t => {
				const h = await harness(t, { cache_upkeep: mode, keepalive_limit: "1", compact_threshold: "1k", cache_ttl: "1h", subagent_cache_ttl: "5m" }, child);
				const original = await openAiReal(h, api);
				await h.tick(1_769_000);
				assert.equal(h.calls.length + h.compactions(), 0);
				await h.tick(1000);
				const warms = mode === "warm" || mode === "warmcomp";
				assert.equal(h.calls.length, warms ? 1 : 0);
				assert.equal(h.compactions(), mode === "compact" ? 1 : 0);
				if (warms) {
					const p = h.calls[0].payload;
					assert.deepEqual(p.input.slice(0, original.input.length), original.input);
					for (const key of ["instructions", "reasoning", "tools", "prompt_cache_key"]) assert.deepEqual(p[key], original[key]);
					assert.equal(p.max_output_tokens, api === "openai-responses" ? 16 : undefined);
					assert.equal(p.max_tokens, undefined);
					assert.equal(h.calls[0].options.transport, "sse");
					const completed = h.entries.findLast(e => e.data?.kind === "keepalive").data;
					assert.equal(completed.usageUnknown, false);
					assert.equal(completed.write, 20); assert.equal(completed.fresh, 5); assert.equal(completed.output, 8);
				}
				await h.tick(1_770_000);
				assert.equal(h.calls.length, warms ? 1 : 0);
				assert.equal(h.compactions(), mode === "compact" || mode === "warmcomp" ? 1 : 0);
				await h.commands.get("keepalive").handler("status", h.c);
				assert.ok(h.notices.at(-1)?.includes("TTL 30m"));
			});
		}
	}
	test(`${api}: default pricing eventually exhausts the warming budget`, async t => {
		const h = await harness(t, { keepalive_limit: "default" });
		await openAiReal(h, api);
		for (let i = 0; i < 30; i++) await h.tick(1_770_000);
		assert.ok(h.calls.length > 0 && h.calls.length < 15);
		await h.commands.get("keepalive").handler("status", h.c);
		assert.ok(h.notices.at(-1)?.includes("rewriting the cache"));
	});
	test(`${api}: missing usage consumes the price budget and warmcomp can compact`, async t => {
		const h = await harness(t, { cache_upkeep: "warmcomp", keepalive_limit: "default", compact_threshold: "1k" });
		t.mock.method(h.c.modelRegistry, "streamSimple", (_m: any, _c: any, opts: any) => {
			h.calls.push({ payload: opts.onPayload(), options: opts });
			return { result: async () => ({ errorMessage: "lost connection" }) };
		});
		await openAiReal(h, api); await h.tick(1_770_000);
		assert.equal(h.calls.length, 1); assert.equal(h.compactions(), 1);
		assert.equal(h.entries.findLast(e => e.data?.kind === "keepalive").data.usageUnknown, true);
		await h.tick(1000); assert.equal(h.calls.length, 1);
	});
	test(`${api}: real turns cancel probes and retain unknown spend, not a false TTL refresh`, async t => {
		const h = await harness(t);
		await openAiReal(h, api); h.defer(); await h.tick(1_770_000);
		await h.emit("agent_start");
		assert.equal(h.calls[0].options.signal.aborted, true);
		await h.release();
		assert.equal(h.entries.findLast(e => e.data?.kind === "keepalive").data.usageUnknown, true);
	});
	test(`${api}: cache opt-out is preserved`, async t => {
		const h = await harness(t);
		const payload = await openAiReal(h, api, { prompt_cache_options: { mode: "explicit" } });
		assert.equal(payload.prompt_cache_options.mode, "explicit");
		await h.tick(1_770_000); assert.equal(h.calls.length, 0);
	});
}

test("raw OpenAI usage supplies cache writes even when older host normalization omits them", async t => {
	const h = await harness(t);
	Object.assign(h.c.model, { id: "gpt-6-sol", api: "openai-responses" });
	await h.emit("agent_start");
	await h.emit("before_provider_request", { payload: { model: h.c.model.id, input: [], max_output_tokens: 4096 } });
	await h.raw({ type: "response.completed", response: { usage: { input_tokens: 10_005,
		input_tokens_details: { cache_write_tokens: 10_000 }, output_tokens: 1 } } });
	await h.emit("message_end", { message: { role: "assistant", provider: "test", model: h.c.model.id,
		usage: { input: 10_005, cacheWrite: 0, cacheRead: 0, output: 1 } } });
	await h.emit("agent_settled");
	const saved = h.entries.at(-1).data;
	assert.equal(saved.write, 10_000); assert.equal(saved.fresh, 5);
	await h.tick(1_770_000); assert.equal(h.calls.length, 1);
});

test("OpenAI default budget reserves uncached input rather than replaying an expensive suffix", async t => {
	const h = await harness(t, { keepalive_limit: "default" });
	await openAiReal(h, "openai-codex-responses", {}, 50_000);
	await h.tick(1_770_000);
	assert.equal(h.calls.length, 0);
});

test("OpenAI native warming uses actual 30m metadata and is accounted once", async t => {
	const h = await harness(t);
	await openAiReal(h, "openai-codex-responses");
	await h.emit("agent_start");
	assert.deepEqual(await h.emit("cache_warming_decision", { action: "warm" }), { action: "stop" });
	h.c.model.promptCache = { short: 1800, long: 1800 };
	assert.equal(await h.emit("cache_warming_decision", { action: "warm" }), undefined);
	await h.emit("before_provider_request", { payload: { model: h.c.model.id, input: [] } });
	const data = { type: "response.done", response: { usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 10_000 }, output_tokens: 1 } } };
	await h.raw(data); await h.raw(data);
	assert.equal(h.entries.filter(e => e.data?.via === "pi-warmer").length, 1);
});

test("infinite OpenAI warming never falls back to compaction after a failed probe", async t => {
	const h = await harness(t, { cache_upkeep: "warmcomp", keepalive_limit: "infinite", compact_threshold: "1k" });
	t.mock.method(h.c.modelRegistry, "streamSimple", () => ({ result: async () => ({}) }));
	await openAiReal(h, "openai-codex-responses");
	await h.tick(1_770_000);
	assert.equal(h.compactions(), 0);
});

test("old Codex 5m metadata is migrated in memory without rewriting saved history", async t => {
	const h = await harness(t);
	Object.assign(h.c.model, { id: "gpt-6-sol", api: "openai-codex-responses" });
	const stored = { id: "old-codex", kind: "real", model: "test/gpt-6-sol", api: "openai-codex-responses",
		startedAt: Date.now(), read: 10_000, write: 0, fresh: 0, output: 1, declaredTtlMs: 300_000 };
	h.entries.push({ type: "custom", customType: "keepalive-sample", data: stored });
	await h.emit("session_start");
	await h.tick(270_000);
	await h.commands.get("keepalive").handler("status", h.c);
	assert.ok(h.notices.at(-1)?.includes("1530s left"));
	assert.equal(stored.declaredTtlMs, 300_000);
	assert.equal(h.calls.length, 0);
});

test("OpenAI TTL is fixed without discarding the session's Anthropic TTL choice", async t => {
	const h = await harness(t);
	await h.commands.get("keepalive").handler("ttl 1h", h.c);
	await openAiReal(h, "openai-responses");
	await h.commands.get("keepalive").handler("ttl 5m", h.c);
	assert.ok(h.notices.at(-1)?.includes("fixed 30-minute"));
	await h.commands.get("keepalive").handler("ttl 30m", h.c);
	assert.ok(h.notices.at(-1)?.includes("30m"));
	Object.assign(h.c.model, { id: "claude-sonnet-4-5", api: "anthropic-messages" });
	await h.emit("model_select");
	await h.commands.get("keepalive").handler("status", h.c);
	assert.ok(h.notices.at(-1)?.includes("TTL 1h"));
});
