/**
 * keepalive — prompt-cache controller for pi.
 *
 * Shows how long the conversation's prompt cache has left, lets you pick the
 * cache TTL sent to Anthropic (5m / 1h) per session, and keeps an idle cache
 * from expiring with one of four upkeep modes:
 *
 *   off      nothing is sent (provider default behaviour)
 *   warm     a keepalive 30s before expiry, while keepalives cost less than
 *            rewriting the cache (configurable limit)
 *   compact  compact the conversation 30s before expiry (if over the threshold)
 *   warmcomp warm until the keepalive budget is spent, then compact
 *
 * Port of agent-router's keepalive mod (keepalive/README.md) to pi.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	buildLedger,
	cacheStatus,
	cacheTokens,
	keepalivesLeft,
	type Ledger,
	type Prices,
	reportedCreation,
	type Sample,
	type Ttl,
	type Upkeep,
	UPKEEP_MODES,
	validSample,
} from "./cache.ts";
import { lookUpPrices } from "./prices.ts";
import { dataDir, DEFAULTS, type KeepaliveSettings, limitOf, loadSettings, saveSettings, thresholdOf } from "./settings.ts";
import { type BarSegment, Dashboard, GUIDE, renderBar, type RequestFilter, type View } from "./ui.ts";

const SAMPLE_ENTRY = "keepalive-sample";
const STATE_ENTRY = "keepalive-state";
const WIDGET = "keepalive";
const KEEPALIVE_TIMEOUT_MS = 60_000;
const PENDING_STALE_MS = 10 * 60_000;
const PRICE_REFRESH_MS = 3_600_000;

interface Snapshot {
	payload: any;
	provider: string;
	modelId: string;
	api: string;
	capturedAt: number;
}

interface PendingRequest {
	kind: "real" | "pi-warmer";
	startedAt: number;
	model: string;
	api: string;
	requested?: Ttl;
	declaredTtlMs?: number;
	started?: boolean;
	done?: boolean;
	startUsage?: any;
	deltaUsage?: any;
}

// ------------------------------------------------------------ payload helpers

function isAnthropicPayload(p: any): boolean {
	return !!p && typeof p === "object" && Array.isArray(p.messages) && typeof p.max_tokens === "number";
}

/** Every cache_control object in an Anthropic Messages payload. */
function cacheControls(p: any): any[] {
	const out: any[] = [];
	const visit = (block: any) => {
		if (block && typeof block === "object" && block.cache_control && typeof block.cache_control === "object") out.push(block.cache_control);
	};
	if (Array.isArray(p.system)) p.system.forEach(visit);
	if (Array.isArray(p.tools)) p.tools.forEach(visit);
	for (const m of p.messages ?? []) {
		visit(m);
		if (Array.isArray(m?.content)) m.content.forEach(visit);
	}
	return out;
}

function payloadTtl(p: any): Ttl | undefined {
	const controls = cacheControls(p).filter((c) => c.type === "ephemeral");
	if (!controls.length) return undefined;
	return controls.every((c) => c.ttl === "1h") ? "1h" : "5m";
}

function setPayloadTtl(p: any, ttl: Ttl): boolean {
	let changed = false;
	for (const c of cacheControls(p)) {
		if (c.type !== "ephemeral") continue;
		if (ttl === "1h" && c.ttl !== "1h") {
			c.ttl = "1h";
			changed = true;
		} else if (ttl === "5m" && c.ttl !== undefined && c.ttl !== "5m") {
			delete c.ttl;
			changed = true;
		}
	}
	return changed;
}

const usageNumbers = (start: any, delta: any) => ({
	read: delta?.cache_read_input_tokens ?? start?.cache_read_input_tokens ?? 0,
	write: delta?.cache_creation_input_tokens ?? start?.cache_creation_input_tokens ?? 0,
	fresh: delta?.input_tokens ?? start?.input_tokens ?? 0,
	output: delta?.output_tokens ?? start?.output_tokens ?? 0,
});

const trusted = (c: ExtensionContext) => {
	try {
		return c.isProjectTrusted();
	} catch {
		return false;
	}
};

const uid = (prefix: string) => `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

// ------------------------------------------------------------------ extension

export default function keepalive(pi: ExtensionAPI) {
	const isChild = process.env.PI_SUBAGENT_CHILD === "1";

	let ctx: ExtensionContext | undefined;
	let settings: KeepaliveSettings = DEFAULTS;
	let samples: Sample[] = [];
	let ledger: Ledger = buildLedger([]);
	let mode: Upkeep = "off";
	let ttlChoice: Ttl | undefined;
	let snapshot: Snapshot | undefined;
	let pending: PendingRequest[] = [];
	let actedAt: number | undefined;
	let busy: "keepalive" | "compact" | undefined;
	let agentRunning = false;
	let compactStartedAt: number | undefined;
	let keepaliveAbort: AbortController | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetTui: TUI | undefined;
	let dashboardTui: TUI | undefined;
	let dashboardOpen = false;
	const notes = new Map<string, string>();
	let price: { key: string; value: Prices | null; at: number; lookup?: Promise<void> } | undefined;

	// ---------------------------------------------------------------- state

	const now = () => Date.now();

	function rebuild() {
		ledger = buildLedger(samples);
	}

	function record(sample: Sample) {
		if (!validSample(sample)) return;
		samples.push(sample);
		rebuild();
		try {
			const { miss: _miss, ...persisted } = sample;
			pi.appendEntry(SAMPLE_ENTRY, persisted);
		} catch {
			// Persistence is best-effort.
		}
		redraw();
	}

	function persistState() {
		try {
			pi.appendEntry(STATE_ENTRY, { mode, ttl: ttlChoice ?? null });
		} catch {
			// best-effort
		}
	}

	function restore(c: ExtensionContext) {
		samples = [];
		mode = isChild ? "off" : settings.cache_upkeep;
		ttlChoice = undefined;
		for (const entry of c.sessionManager.getBranch() as any[]) {
			if (entry?.type !== "custom") continue;
			if (entry.customType === SAMPLE_ENTRY && validSample(entry.data)) samples.push(entry.data);
			else if (entry.customType === STATE_ENTRY && entry.data) {
				if (UPKEEP_MODES.includes(entry.data.mode)) mode = entry.data.mode;
				ttlChoice = entry.data.ttl === "5m" || entry.data.ttl === "1h" ? entry.data.ttl : undefined;
			}
		}
		if (isChild) mode = "off";
		snapshot = undefined;
		pending = [];
		actedAt = undefined;
		rebuild();
	}

	// ------------------------------------------------------------------ TTL

	function defaultTtl(): { value: Ttl; source: string } {
		const setting = isChild ? settings.subagent_cache_ttl : settings.cache_ttl;
		if (setting !== "default") return { value: setting, source: `${isChild ? "subagent" : "main conversation"} TTL in /keepalive-settings` };
		if (process.env.PI_CACHE_RETENTION === "long") return { value: "1h", source: "pi default (PI_CACHE_RETENTION=long)" };
		return { value: "5m", source: "pi default (short cache retention)" };
	}

	const effectiveTtl = (): Ttl => ttlChoice ?? defaultTtl().value;

	function ttlSupported(model = ctx?.model): boolean {
		return model?.api === "anthropic-messages" && (model?.compat as any)?.supportsLongCacheRetention !== false;
	}

	function declaredTtlMs(model: any, requested: Ttl | undefined): number | undefined {
		const tier = requested ? (requested === "1h" ? "long" : "short") : process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const seconds = model?.promptCache?.[tier];
		return typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : undefined;
	}

	// --------------------------------------------------------------- prices

	function ensurePrices(): Promise<void> | undefined {
		const model = ctx?.model;
		const last = ledger.last;
		if (!model || !last) return;
		const contextTokens = last.read + last.write + last.fresh;
		const key = `${model.provider}/${model.id}`;
		if (price?.key === key && (price.lookup || now() - price.at < PRICE_REFRESH_MS)) return price.lookup;
		const entry: NonNullable<typeof price> = { key, value: price?.key === key ? price.value : null, at: now() };
		price = entry;
		entry.lookup = lookUpPrices(model, {
			root: dataDir(),
			allowNetwork: settings.models_dev && !process.env.PI_OFFLINE,
			contextTokens,
		})
			.then((value) => {
				entry.value = value;
			})
			.catch(() => {})
			.finally(() => {
				entry.at = now();
				entry.lookup = undefined;
				redraw();
			});
		return entry.lookup;
	}

	// --------------------------------------------------------------- replay

	function replayable(): { ok: boolean; reason?: string } {
		if (!snapshot) return { ok: false, reason: "no request captured since start, compaction, branch or thinking change" };
		if (snapshot.api !== "anthropic-messages") return { ok: false, reason: `not supported for ${snapshot.api}` };
		const model = ctx?.model;
		if (model && (model.provider !== snapshot.provider || model.id !== snapshot.modelId))
			return { ok: false, reason: "model changed since the last request" };
		return { ok: true };
	}

	async function sendKeepalive(c: ExtensionContext) {
		const snap = snapshot!;
		const model = c.modelRegistry.find(snap.provider, snap.modelId);
		if (!model) {
			notes.set("keepalive", `keepalive skipped: ${snap.provider}/${snap.modelId} is not in the model registry`);
			return;
		}
		const payload = structuredClone(snap.payload);
		if (ttlSupported(model)) setPayloadTtl(payload, effectiveTtl());
		const requested = payloadTtl(payload);
		// Budget-based thinking keys the cache on budget_tokens, so it must stay; max_tokens must exceed it.
		// The stream is aborted as soon as message_start reports usage, so almost nothing is generated.
		const budget = payload.thinking?.type === "enabled" && Number.isFinite(payload.thinking.budget_tokens) ? payload.thinking.budget_tokens : undefined;
		payload.max_tokens = budget ? budget + 1 : 1;
		const controller = new AbortController();
		keepaliveAbort = controller;
		const timeout = setTimeout(() => controller.abort(), KEEPALIVE_TIMEOUT_MS);
		let start: any;
		let delta: any;
		const startedAt = now();
		busy = "keepalive";
		redraw();
		try {
			const stream = c.modelRegistry.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with only: OK", timestamp: startedAt }] } as any,
				{
					maxTokens: 1,
					maxRetries: 0,
					signal: controller.signal,
					sessionId: c.sessionManager.getSessionId(),
					reasoning: c.thinkingLevel && c.thinkingLevel !== "off" ? c.thinkingLevel : undefined,
					onPayload: () => payload,
					onProviderStreamEvent: (data: any) => {
						if (data?.type === "message_start") {
							start = data.message?.usage;
							if (budget) controller.abort();
						} else if (data?.type === "message_delta" && data.usage) delta = data.usage;
					},
				} as any,
			);
			const result: any = await stream.result();
			if (!start && result?.errorMessage) notes.set("keepalive", `last keepalive failed: ${String(result.errorMessage).slice(0, 160)}`);
		} catch (error: any) {
			if (!start) notes.set("keepalive", `last keepalive failed: ${String(error?.message ?? error).slice(0, 160)}`);
		} finally {
			clearTimeout(timeout);
			if (keepaliveAbort === controller) keepaliveAbort = undefined;
			busy = undefined;
		}
		if (!start) {
			redraw();
			return;
		}
		notes.delete("keepalive");
		const numbers = usageNumbers(start, delta);
		const creation = reportedCreation(delta?.cache_creation ? delta : start);
		record({
			id: uid("keepalive"),
			kind: "keepalive",
			via: "keepalive",
			model: `${snap.provider}/${snap.modelId}`,
			api: snap.api,
			startedAt,
			completedAt: now(),
			...numbers,
			...(creation ? { creation } : {}),
			...(requested ? { requested } : {}),
			declaredTtlMs: declaredTtlMs(model, requested),
		});
	}

	function compact(c: ExtensionContext) {
		const before = ledger.last ? ledger.last.read + ledger.last.write + ledger.last.fresh : 0;
		busy = "compact";
		compactStartedAt = now();
		redraw();
		try {
			c.compact({
				customInstructions: undefined,
				onComplete: () => {
					busy = undefined;
					notes.delete("compact");
					if (c.hasUI) c.ui.notify(`Keepalive compacted the conversation (${cacheTokens(before)} tokens) before its prompt cache expired.`, "info");
					redraw();
				},
				onError: (error: Error) => {
					busy = undefined;
					notes.set("compact", `compaction refused: ${error.message.slice(0, 160)}`);
					redraw();
				},
			});
		} catch (error: any) {
			busy = undefined;
			notes.set("compact", `compaction could not start: ${String(error?.message ?? error).slice(0, 160)}`);
		}
	}

	// --------------------------------------------------------------- upkeep

	function pendingReal() {
		return pending.filter((p) => p.kind === "real" && !p.done);
	}

	async function upkeep() {
		const c = ctx;
		if (!c || isChild || mode === "off" || busy) return;
		if (agentRunning || !c.isIdle() || c.hasPendingMessages() || pendingReal().length) return;
		const status = cacheStatus(ledger, now());
		if (status.state !== "warm" || (status.basis !== "reported" && status.basis !== "declared")) return;
		const leadMs = settings.upkeep_lead_seconds * 1000;
		if (!status.leftMs || status.leftMs > leadMs) return;
		if (ledger.touchedAt === undefined || actedAt === ledger.touchedAt) return;
		actedAt = ledger.touchedAt;
		const warms = mode === "warm" || mode === "warmcomp";
		const limit = limitOf(settings);
		const last = ledger.last!;
		if (warms && replayable().ok) {
			if (limit === undefined) await ensurePrices();
			const left = keepalivesLeft(ledger, price?.value, limit, effectiveTtl() === "1h");
			if (left !== null && left > 0) {
				notes.delete("upkeep");
				return sendKeepalive(c);
			}
		}
		if (mode !== "warm" && last.read + last.write + last.fresh >= thresholdOf(settings)) return compact(c);
		if (warms) {
			notes.set(
				"upkeep",
				!replayable().ok
					? `warming skipped: ${replayable().reason}`
					: limit !== undefined
						? `warming stopped at the keepalive limit of ${limit}`
						: price?.value
							? "warming paused: another keepalive would cost more than rewriting the cache"
							: "warming off: no price found for this model (set a numeric keepalive limit to warm anyway)",
			);
		}
	}

	// ----------------------------------------------------------------- view

	function piWarmingText(): string {
		const s: any = pi.getSettings?.() ?? {};
		const warming = s.cacheWarming ?? "streaming";
		const model: any = ctx?.model;
		const parts = [`${warming} (settings.json cacheWarming)`];
		if (warming !== "off" && !model?.promptCache) parts.push("inactive: model declares no promptCache lifetime");
		if (warming === "idle" && mode !== "off") parts.push("idle refreshes left to keepalive");
		if (effectiveTtl() === "1h" && ttlSupported()) parts.push("refreshes skipped on a 1h cache");
		return parts.join(" · ");
	}

	/** Dollar cost of keepalives this session, priced with pi's model registry. */
	function spendText(): string | undefined {
		let total = 0;
		let count = 0;
		let priced = true;
		for (const s of ledger.samples) {
			if (s.kind !== "keepalive") continue;
			count++;
			const [provider, ...rest] = s.model.split("/");
			const cost: any = ctx?.modelRegistry.find(provider, rest.join("/"))?.cost;
			if (!cost?.input) {
				priced = false;
				continue;
			}
			const oneHour = s.creation?.oneHour ?? 0;
			total += (s.read * cost.cacheRead + (s.write - oneHour) * cost.cacheWrite + oneHour * 2 * cost.input + s.fresh * cost.input + s.output * cost.output) / 1e6;
		}
		if (!count) return undefined;
		return `${count} keepalive${count === 1 ? "" : "s"} this session · $${total.toFixed(4)}${priced ? "" : " (some unpriced)"}`;
	}

	function view(): View {
		const t = now();
		const reals = pendingReal();
		const pendingAt = reals.length ? reals.at(-1)!.startedAt : undefined;
		const status = cacheStatus(ledger, t, pendingAt);
		const limit = limitOf(settings);
		const warms = mode === "warm" || mode === "warmcomp";
		if (warms && limit === undefined && ledger.last) ensurePrices();
		const left = keepalivesLeft(ledger, price?.value, limit, effectiveTtl() === "1h");
		const last = ledger.last;
		const def = defaultTtl();
		const viewNotes = [...notes.values()];
		if (busy === "keepalive") viewNotes.unshift("sending keepalive…");
		if (busy === "compact") viewNotes.unshift("compacting…");
		return {
			now: t,
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			ledger,
			status,
			mode: isChild ? null : mode,
			ttl: { value: effectiveTtl(), source: ttlChoice ? "chosen for this session" : def.source, chosen: !!ttlChoice, supported: ttlSupported() },
			left,
			compactable: !!last && last.read + last.write + last.fresh >= thresholdOf(settings),
			limit,
			threshold: thresholdOf(settings),
			leadMs: settings.upkeep_lead_seconds * 1000,
			prices: price?.value,
			pricesPending: !!price?.lookup && !price.value,
			replay: replayable(),
			pending: reals.length > 0,
			piWarming: piWarmingText(),
			spend: spendText(),
			notes: viewNotes,
		};
	}

	function redraw() {
		widgetTui?.requestRender();
		dashboardTui?.requestRender();
	}

	// -------------------------------------------------------------- actions

	function cycleMode() {
		if (isChild) return;
		mode = UPKEEP_MODES[(UPKEEP_MODES.indexOf(mode) + 1) % UPKEEP_MODES.length];
		actedAt = undefined;
		notes.delete("upkeep");
		persistState();
		redraw();
	}

	function setTtl(value: Ttl | undefined) {
		ttlChoice = value;
		persistState();
		redraw();
	}

	function toggleTtl() {
		if (!ttlSupported()) {
			ctx?.hasUI && ctx.ui.notify("Keepalive: the cache TTL can only be set for Anthropic Messages models.", "warning");
			return;
		}
		setTtl(effectiveTtl() === "5m" ? "1h" : "5m");
	}

	async function openDashboard(c: ExtensionContext, filter: RequestFilter = "all") {
		if (c.mode !== "tui" || dashboardOpen) return;
		dashboardOpen = true;
		try {
			await c.ui.custom<void>(
				(tui, theme, _kb, done) => {
					dashboardTui = tui;
					return new Dashboard(theme, view, { cycleMode, toggleTtl, close: () => done(undefined), render: () => tui.requestRender() }, filter);
				},
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center" } as any },
			);
		} finally {
			dashboardTui = undefined;
			dashboardOpen = false;
		}
	}

	function installWidget(c: ExtensionContext) {
		if (!c.hasUI || c.mode !== "tui" || isChild) return;
		if (!settings.show_bar) {
			c.ui.setWidget(WIDGET, undefined);
			widgetTui = undefined;
			return;
		}
		c.ui.setWidget(
			WIDGET,
			(tui, theme) => {
				widgetTui = tui;
				let segments: BarSegment[] = [];
				return {
					render(width: number) {
						const out = renderBar(theme, view(), width);
						segments = out.segments;
						return [out.line];
					},
					handleMouse(event: any) {
						if (event.type !== "click" || event.button !== "left") return undefined;
						const hit = segments.find((s) => event.x >= s.from && event.x < s.to);
						if (!hit) return undefined;
						if (hit.action === "mode") cycleMode();
						else if (hit.action === "ttl") toggleTtl();
						else if (ctx) void openDashboard(ctx, hit.action === "misses" ? "misses" : "all");
						return { handled: true, render: true };
					},
					invalidate() {},
					dispose() {
						if (widgetTui === tui) widgetTui = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		if (!settings.guide_shown) {
			c.ui.notify(GUIDE.join("\n"), "info");
			settings = { ...settings, guide_shown: true };
			saveSettings(c.cwd, { guide_shown: true });
		}
	}

	function startTimer() {
		stopTimer();
		let lastSecond = 0;
		timer = setInterval(() => {
			const t = now();
			// Forget requests whose completion was never observed (e.g. aborted outside the agent loop).
			pending = pending.filter((p) => !p.done && t - p.startedAt < PENDING_STALE_MS);
			void upkeep().catch(() => {});
			const second = Math.floor(t / 1000);
			if (second !== lastSecond) {
				lastSecond = second;
				if (ledger.last || ledger.compaction || pending.length) redraw();
			}
		}, 1000);
		timer.unref?.();
	}

	function stopTimer() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	// --------------------------------------------------------------- events

	pi.on("session_start", (_event, c) => {
		ctx = c;
		settings = loadSettings(c.cwd, trusted(c));
		restore(c);
		installWidget(c);
		startTimer();
	});

	pi.on("session_tree", (_event, c) => {
		ctx = c;
		restore(c);
		redraw();
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		widgetTui = undefined;
		dashboardTui = undefined;
		ctx = undefined;
	});

	pi.on("model_select", (_event, c) => {
		ctx = c;
		redraw();
	});

	pi.on("thinking_level_select", (_event, c) => {
		ctx = c;
		// The thinking parameters are part of the cache key; the captured request no longer matches the next one.
		snapshot = undefined;
		redraw();
	});

	pi.on("agent_start", (_event, c) => {
		ctx = c;
		agentRunning = true;
		// A real turn supersedes a keepalive still in flight; it becomes the new cache anchor.
		keepaliveAbort?.abort();
	});

	pi.on("agent_settled", (_event, c) => {
		ctx = c;
		agentRunning = false;
		pending = pending.filter((p) => p.kind !== "real");
		redraw();
	});

	pi.on("before_provider_request", (event, c) => {
		ctx = c;
		const payload: any = event.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const model: any = c.model;
		const anthropic = isAnthropicPayload(payload);
		// pi's own cache warmer replays the last request with a one-token cap; idle replays happen outside a run.
		const kind: PendingRequest["kind"] = !agentRunning || (anthropic && payload.max_tokens === 1) ? "pi-warmer" : "real";
		let requested: Ttl | undefined;
		if (anthropic) {
			if (ttlSupported(model) && payloadTtl(payload)) setPayloadTtl(payload, effectiveTtl());
			requested = payloadTtl(payload);
		}
		const modelId = anthropic && typeof payload.model === "string" ? payload.model : model?.id;
		const provider = model?.provider ?? "unknown";
		pending.push({
			kind,
			startedAt: now(),
			model: `${provider}/${modelId}`,
			api: model?.api ?? "unknown",
			requested,
			declaredTtlMs: declaredTtlMs(model, requested),
		});
		if (kind === "real") {
			if (anthropic) {
				try {
					snapshot = { payload: structuredClone(payload), provider, modelId, api: model?.api, capturedAt: now() };
				} catch {
					snapshot = undefined;
				}
			} else snapshot = { payload: undefined, provider, modelId, api: model?.api ?? "unknown", capturedAt: now() };
			actedAt = undefined;
			notes.delete("upkeep");
		}
		redraw();
		return payload;
	});

	pi.on("provider_stream_event", (event) => {
		const data: any = event.data;
		if (!data || typeof data !== "object") return;
		if (data.type === "message_start") {
			// Requests are sequential; the newest unanswered one is the one that just started streaming.
			const rec = [...pending].reverse().find((p) => !p.started && !p.done);
			if (!rec) return;
			rec.started = true;
			rec.startUsage = data.message?.usage;
		} else if (data.type === "message_delta" && data.usage) {
			const rec = [...pending].reverse().find((p) => p.started && !p.done);
			if (!rec) return;
			rec.deltaUsage = data.usage;
			if (rec.kind === "pi-warmer") {
				rec.done = true;
				const numbers = usageNumbers(rec.startUsage, rec.deltaUsage);
				const creation = reportedCreation(rec.deltaUsage?.cache_creation ? rec.deltaUsage : rec.startUsage);
				record({
					id: uid("pi-warm"),
					kind: "keepalive",
					via: "pi-warmer",
					model: rec.model,
					api: rec.api,
					startedAt: rec.startedAt,
					completedAt: now(),
					...numbers,
					...(creation ? { creation } : {}),
					...(rec.requested ? { requested: rec.requested } : {}),
					declaredTtlMs: rec.declaredTtlMs,
				});
			}
		}
	});

	pi.on("message_end", (event, c) => {
		ctx = c;
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		const reals = pendingReal();
		const rec = reals.at(-1);
		for (const p of reals) p.done = true;
		pending = pending.filter((p) => !p.done);
		const usage = message.usage;
		if (!usage) return;
		const read = usage.cacheRead ?? 0;
		const write = usage.cacheWrite ?? 0;
		const fresh = usage.input ?? 0;
		const output = usage.output ?? 0;
		if (read + write + fresh + output === 0) {
			redraw();
			return;
		}
		const raw = rec?.deltaUsage?.cache_creation ? rec.deltaUsage : rec?.startUsage;
		const creation = raw ? reportedCreation({ ...raw, cache_creation_input_tokens: write }) : undefined;
		record({
			id: message.responseId ? `real:${message.responseId}` : uid("real"),
			kind: "real",
			model: rec?.model ?? `${message.provider}/${message.model}`,
			api: message.api ?? rec?.api,
			startedAt: rec?.startedAt ?? message.timestamp ?? now(),
			completedAt: now(),
			read,
			write,
			fresh,
			output,
			...(creation ? { creation } : {}),
			...(rec?.requested ? { requested: rec.requested } : {}),
			declaredTtlMs: rec?.declaredTtlMs ?? declaredTtlMs(c.model, undefined),
		});
	});

	pi.on("session_before_compact", () => {
		compactStartedAt ??= now();
	});

	pi.on("session_compact", (event, c) => {
		ctx = c;
		const entry: any = event.compactionEntry;
		const usage = entry?.usage;
		let after: number | undefined;
		try {
			const u: any = c.getContextUsage();
			after = typeof u?.tokens === "number" ? u.tokens : undefined;
		} catch {
			after = undefined;
		}
		record({
			id: `compaction:${entry?.id ?? uid("c")}`,
			kind: "compaction",
			model: c.model ? `${c.model.provider}/${c.model.id}` : "unknown",
			startedAt: compactStartedAt ?? now(),
			completedAt: now(),
			read: usage?.cacheRead ?? 0,
			write: usage?.cacheWrite ?? 0,
			fresh: usage?.input ?? 0,
			output: usage?.output ?? 0,
			...(Number.isSafeInteger(entry?.tokensBefore) ? { tokensBefore: entry.tokensBefore } : {}),
			...(after !== undefined ? { tokensAfter: Math.round(after) } : {}),
		});
		compactStartedAt = undefined;
		snapshot = undefined;
	});

	pi.on("session_compact_failed", () => {
		compactStartedAt = undefined;
	});

	pi.on("cache_warming_decision", (event) => {
		if (isChild) return undefined;
		// Idle refreshes belong to the upkeep mode when one is active.
		if (!agentRunning && mode !== "off") return { action: "stop" };
		// pi assumes the short lifetime unless PI_CACHE_RETENTION=long; a 1h entry needs no 4.5-minute refreshes.
		if (effectiveTtl() === "1h" && ttlSupported() && process.env.PI_CACHE_RETENTION !== "long") return { action: "stop" };
		return undefined;
	});

	// ------------------------------------------------------------- commands

	pi.registerCommand("keepalive", {
		description: "Prompt cache dashboard; /keepalive mode <off|warm|compact|warmcomp>, /keepalive ttl <5m|1h|default>",
		getArgumentCompletions: (prefix: string) => {
			const options = ["mode off", "mode warm", "mode compact", "mode warmcomp", "ttl 5m", "ttl 1h", "ttl default", "status"];
			const items = options.filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o }));
			return items.length ? items : null;
		},
		handler: async (args, c) => {
			ctx = c;
			const [verb, value] = (args ?? "").trim().split(/\s+/);
			if (verb === "mode") {
				if (isChild) return c.ui.notify("Keepalive: subagent sessions have no upkeep.", "warning");
				if (!UPKEEP_MODES.includes(value as Upkeep)) return c.ui.notify(`Usage: /keepalive mode <${UPKEEP_MODES.join("|")}>`, "warning");
				mode = value as Upkeep;
				actedAt = undefined;
				notes.delete("upkeep");
				persistState();
				redraw();
				return c.ui.notify(`Keepalive upkeep: ${mode}`, "info");
			}
			if (verb === "ttl") {
				if (value === "default") setTtl(undefined);
				else if (value === "5m" || value === "1h") {
					if (!ttlSupported()) return c.ui.notify("Keepalive: the cache TTL can only be set for Anthropic Messages models.", "warning");
					setTtl(value);
				} else if (!value) toggleTtl();
				else return c.ui.notify("Usage: /keepalive ttl <5m|1h|default>", "warning");
				return c.ui.notify(`Keepalive TTL: ${effectiveTtl()} (${ttlChoice ? "this session" : defaultTtl().source})`, "info");
			}
			if (c.mode === "tui" && verb !== "status") return openDashboard(c);
			const v = view();
			const s = v.status;
			c.ui.notify(
				[
					`Keepalive · ${v.model ?? "no model"} · upkeep ${v.mode ?? "–"} · TTL ${v.ttl.value} (${v.ttl.source})`,
					`cache: ${s.state}${s.leftMs ? ` · ${Math.ceil(s.leftMs / 1000)}s left` : ""}${s.ttl ? ` · ${s.ttl} ${s.basis}` : ""}`,
					`requests: ${ledger.totals.requests} · read ${cacheTokens(ledger.totals.read)} · write ${cacheTokens(ledger.totals.write)} · new ${cacheTokens(ledger.totals.fresh)}`,
					...v.notes,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("keepalive-settings", {
		description: "Keepalive defaults: TTLs, upkeep mode, keepalive limit, compaction threshold",
		handler: async (_args, c) => {
			ctx = c;
			if (!c.hasUI) return;
			for (;;) {
				settings = loadSettings(c.cwd, trusted(c));
				const def = process.env.PI_CACHE_RETENTION === "long" ? "1h" : "5m";
				const rows: [string, keyof KeepaliveSettings, string][] = [
					["Main conversation TTL", "cache_ttl", settings.cache_ttl === "default" ? `default (${def})` : settings.cache_ttl],
					["Subagent TTL", "subagent_cache_ttl", settings.subagent_cache_ttl === "default" ? `default (${def})` : settings.subagent_cache_ttl],
					["Main conversation upkeep", "cache_upkeep", settings.cache_upkeep],
					["Keepalive limit", "keepalive_limit", settings.keepalive_limit],
					["Compaction threshold", "compact_threshold", settings.compact_threshold],
					["Upkeep lead time (s)", "upkeep_lead_seconds", String(settings.upkeep_lead_seconds)],
					["Download models.dev prices", "models_dev", settings.models_dev ? "on" : "off"],
					["Show cache bar", "show_bar", settings.show_bar ? "on" : "off"],
				];
				const labels = rows.map(([label, , value]) => `${label}: ${value}`);
				const picked = await c.ui.select("Keepalive settings (saved to settings.json → keepalive)", [...labels, "Done"]);
				if (!picked || picked === "Done") return;
				const [, key] = rows[labels.indexOf(picked)];
				const choose = async (title: string, options: string[]) => c.ui.select(title, options);
				let patch: Partial<KeepaliveSettings> | undefined;
				if (key === "cache_ttl" || key === "subagent_cache_ttl") {
					const v = await choose("TTL a new conversation starts with", [`default (${def})`, "5m", "1h"]);
					if (v) patch = { [key]: v.startsWith("default") ? "default" : v } as any;
				} else if (key === "cache_upkeep") {
					const v = await choose("Upkeep a new session starts in", [...UPKEEP_MODES]);
					if (v) patch = { cache_upkeep: v as Upkeep };
				} else if (key === "keepalive_limit") {
					const v = await choose("Keepalives after each request", ["default (while cheaper than rewriting the cache)", "infinite", "6", "12", "24", "Other number"]);
					if (v === "Other number") {
						const n = await c.ui.input("Keepalive limit", "a whole number, e.g. 12");
						if (n && /^\d+$/.test(n.trim())) patch = { keepalive_limit: n.trim() };
						else if (n) c.ui.notify("Not a whole number; unchanged.", "warning");
					} else if (v) patch = { keepalive_limit: v.startsWith("default") ? "default" : v };
				} else if (key === "compact_threshold") {
					const v = await choose("Smallest conversation to compact", ["50k", "100k", "150k", "200k", "Other number"]);
					if (v === "Other number") {
						const n = await c.ui.input("Compaction threshold", "tokens, e.g. 60k, 60000 or 1m");
						if (n && /^[1-9]\d*(\.\d+)?\s*[km]?$/i.test(n.trim())) patch = { compact_threshold: n.trim().toLowerCase() };
						else if (n) c.ui.notify("Not a number of tokens; unchanged.", "warning");
					} else if (v) patch = { compact_threshold: v };
				} else if (key === "upkeep_lead_seconds") {
					const v = await choose("Act this many seconds before expiry", ["15", "30", "45", "60", "90"]);
					if (v) patch = { upkeep_lead_seconds: Number(v) };
				} else if (key === "models_dev" || key === "show_bar") {
					const v = await choose(key === "models_dev" ? "Download the models.dev price catalog (daily)" : "Show the cache bar above the editor", ["on", "off"]);
					if (v) patch = { [key]: v === "on" } as any;
				}
				if (patch) {
					const path = saveSettings(c.cwd, patch, trusted(c));
					if (!path) c.ui.notify("Keepalive: settings.json could not be read or written; nothing saved.", "error");
					settings = loadSettings(c.cwd, trusted(c));
					if ("show_bar" in patch) installWidget(c);
					if ("keepalive_limit" in patch || "upkeep_lead_seconds" in patch) actedAt = undefined;
					redraw();
				}
			}
		},
	});

	pi.registerShortcut("ctrl+alt+k" as any, {
		description: "Keepalive: cycle cache upkeep mode",
		handler: (c) => {
			ctx = c;
			cycleMode();
			if (c.hasUI) c.ui.notify(`Keepalive upkeep: ${mode}`, "info");
		},
	});

	pi.registerShortcut("ctrl+alt+l" as any, {
		description: "Keepalive: toggle cache TTL 5m / 1h",
		handler: (c) => {
			ctx = c;
			toggleTtl();
			if (c.hasUI && ttlSupported()) c.ui.notify(`Keepalive TTL: ${effectiveTtl()}`, "info");
		},
	});
}

