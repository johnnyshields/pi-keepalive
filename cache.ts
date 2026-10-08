/**
 * Pure prompt-cache bookkeeping for the keepalive extension.
 *
 * Ported from agent-router's keepalive mod (lib/cache.js), reduced to the one
 * conversation a pi session owns: the main loop.
 */

export type Ttl = "5m" | "1h";
export type SampleKind = "real" | "keepalive" | "compaction";
export type Grade = "good" | "fair" | "poor";
export type Upkeep = "off" | "warm" | "compact" | "warmcomp";
export const UPKEEP_MODES: Upkeep[] = ["off", "warm", "compact", "warmcomp"];

export interface CacheCreation {
	fiveMinute: number;
	oneHour: number;
}

export interface Sample {
	/** Unique id; repeated ids count once. */
	id: string;
	kind: SampleKind;
	/** provider/modelId */
	model: string;
	api?: string;
	startedAt: number;
	completedAt?: number;
	read: number;
	write: number;
	fresh: number;
	output: number;
	/** 5m/1h write breakdown reported by the response (Anthropic `usage.cache_creation`). */
	creation?: CacheCreation;
	/** TTL the request asked for (Anthropic cache_control). */
	requested?: Ttl;
	/** Lifetime the model declares in models.json `promptCache` for the tier the request used. */
	declaredTtlMs?: number;
	/** Who sent a keepalive: this extension or pi's built-in cache warmer. */
	via?: "keepalive" | "pi-warmer";
	tokensBefore?: number;
	tokensAfter?: number;
	/** Computed, never persisted. */
	miss?: string;
}

export interface Totals {
	requests: number;
	read: number;
	write: number;
	fresh: number;
	output: number;
}

export interface Ledger {
	/** Every sample, sorted, deduplicated, with misses labelled. */
	samples: Sample[];
	/** Last real requests used for the hit rate. */
	recent: Sample[];
	/** Latest real request. */
	last?: Sample;
	/** Latest compaction. */
	compaction?: Sample;
	/** Keepalives since the latest real request. */
	keepalives: Sample[];
	/** Dispatch time of the latest request that read or wrote the cache. */
	touchedAt?: number;
	/** Reported creation of the latest write; null when the write was not reported. */
	creation?: CacheCreation | null;
	/** Declared lifetime of the latest write. */
	declaredTtlMs?: number;
	totals: Totals;
}

export interface Lifetime {
	ttl: Ttl;
	ttlMs: number;
	tokens: number;
	leftMs: number;
}

export type TtlBasis = "reported" | "declared" | "awaiting";

export interface Status {
	state: "no observation" | "compacted" | "uncached" | "TTL not reported" | "warm" | "expired";
	ratio: number | null;
	leftMs: number | null;
	lifetimes: Lifetime[];
	ttl?: string;
	basis?: TtlBasis;
	sample?: Sample;
	compacted?: { before?: number; after?: number };
}

export const RATE_REQUESTS = 10;
export const MISS_WINDOW_MS = 900_000;
export const MISS_FRESH_MS = 300_000;
export const TTL_REPORT_MS = 30_000;
export const TTL_MS: Record<Ttl, number> = { "5m": 300_000, "1h": 3_600_000 };

const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function validSample(s: any): s is Sample {
	return (
		!!s &&
		typeof s === "object" &&
		typeof s.id === "string" &&
		s.id.length > 0 &&
		(s.kind === "real" || s.kind === "keepalive" || s.kind === "compaction") &&
		typeof s.model === "string" &&
		["startedAt", "read", "write", "fresh", "output"].every((k) => count(s[k])) &&
		(s.completedAt === undefined || count(s.completedAt)) &&
		(s.requested === undefined || s.requested === "5m" || s.requested === "1h") &&
		(s.declaredTtlMs === undefined || (count(s.declaredTtlMs) && s.declaredTtlMs > 0)) &&
		(s.tokensBefore === undefined || count(s.tokensBefore)) &&
		(s.tokensAfter === undefined || count(s.tokensAfter)) &&
		(s.creation === undefined || validCreation(s.creation, s.write))
	);
}

export function validCreation(value: any, writes: number): value is CacheCreation {
	return (
		!!value &&
		count(value.fiveMinute) &&
		count(value.oneHour) &&
		value.fiveMinute + value.oneHour === writes &&
		writes > 0
	);
}

/** Read Anthropic's `usage.cache_creation` breakdown, if present and consistent. */
export function reportedCreation(usage: any): CacheCreation | undefined {
	const value = usage?.cache_creation;
	if (!value || typeof value !== "object") return undefined;
	const creation = {
		fiveMinute: value.ephemeral_5m_input_tokens ?? 0,
		oneHour: value.ephemeral_1h_input_tokens ?? 0,
	};
	return validCreation(creation, usage.cache_creation_input_tokens ?? 0) ? creation : undefined;
}

export const sameModel = (a?: string, b?: string) =>
	typeof a === "string" && typeof b === "string" && a.replace(/\[1m\]$/i, "") === b.replace(/\[1m\]$/i, "");

function creationTtlMs(creation: CacheCreation | null | undefined, declared?: number): number | undefined {
	if (creation) return creation.oneHour && !creation.fiveMinute ? TTL_MS["1h"] : TTL_MS["5m"];
	return declared;
}

function missOf(
	s: Sample,
	prior: Sample | undefined,
	touchedAt: number | undefined,
	creation: CacheCreation | null | undefined,
	declared: number | undefined,
): string | undefined {
	const expected = prior ? prior.read + prior.write : 0;
	if (!prior || !expected || expected - s.read < Math.max(2000, expected * 0.05)) return undefined;
	if (!sameModel(prior.model, s.model)) return "model changed";
	if (s.requested === "1h" && (prior.requested ?? "5m") !== "1h") return "TTL changed";
	const ttlMs = creationTtlMs(creation, declared);
	if (!ttlMs || touchedAt === undefined) return "cache miss";
	return s.startedAt - touchedAt >= ttlMs ? "expired" : "prefix changed";
}

export function buildLedger(input: Sample[]): Ledger {
	const unique = new Map<string, Sample>();
	for (const s of input) if (validSample(s)) unique.set(s.id, { ...s, miss: undefined });
	const samples = [...unique.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const ledger: Ledger = {
		samples,
		recent: [],
		keepalives: [],
		totals: { requests: 0, read: 0, write: 0, fresh: 0, output: 0 },
	};
	/** Base for miss detection; a compaction replaces the conversation, so it resets. */
	let missBase: Sample | undefined;
	let cacheModel: string | undefined;
	for (const s of samples) {
		if (s.kind !== "compaction" || s.read + s.write + s.fresh + s.output > 0) ledger.totals.requests++;
		ledger.totals.read += s.read;
		ledger.totals.write += s.write;
		ledger.totals.fresh += s.fresh;
		ledger.totals.output += s.output;
		if (s.kind === "compaction") {
			ledger.compaction = s;
			ledger.keepalives = [];
			ledger.touchedAt = undefined;
			ledger.creation = undefined;
			ledger.declaredTtlMs = undefined;
			missBase = undefined;
			cacheModel = undefined;
			continue;
		}
		if (s.kind === "real") s.miss = missOf(s, missBase, ledger.touchedAt, ledger.creation, ledger.declaredTtlMs);
		if (cacheModel && !sameModel(cacheModel, s.model)) {
			ledger.creation = undefined;
			ledger.declaredTtlMs = undefined;
			ledger.touchedAt = undefined;
		}
		cacheModel = s.model;
		if (s.write > 0) {
			ledger.creation = s.creation ?? null;
			ledger.declaredTtlMs = s.declaredTtlMs;
		} else if (ledger.declaredTtlMs === undefined) {
			ledger.declaredTtlMs = s.declaredTtlMs;
		}
		if (s.read + s.write > 0) ledger.touchedAt = s.startedAt;
		if (s.kind === "keepalive") {
			ledger.keepalives.push(s);
			continue;
		}
		ledger.last = s;
		missBase = s;
		ledger.recent = [...ledger.recent, s].slice(-RATE_REQUESTS);
		ledger.keepalives = [];
	}
	return ledger;
}

/** Lifetime of the cache entry for status: reported, declared, or awaited from the requested TTL. */
function resolveCreation(ledger: Ledger, sample: Sample, now: number): { creation: CacheCreation; basis: TtlBasis } | null {
	if (ledger.creation) return { creation: ledger.creation, basis: "reported" };
	const tokens = Math.max(1, sample.read + sample.write);
	const declared = ledger.declaredTtlMs ?? sample.declaredTtlMs;
	if (declared === TTL_MS["1h"]) return { creation: { fiveMinute: 0, oneHour: tokens }, basis: "declared" };
	if (declared !== undefined) return { creation: { fiveMinute: tokens, oneHour: 0 }, basis: "declared" };
	if (sample.requested && (sample.completedAt === undefined || now - sample.completedAt < TTL_REPORT_MS)) {
		const creation = sample.requested === "1h" ? { fiveMinute: 0, oneHour: tokens } : { fiveMinute: tokens, oneHour: 0 };
		return { creation, basis: "awaiting" };
	}
	return null;
}

export function cacheStatus(ledger: Ledger | undefined, now: number, pendingAt?: number): Status {
	const compaction =
		ledger?.compaction && (!ledger.last || ledger.compaction.startedAt >= ledger.last.startedAt) ? ledger.compaction : undefined;
	const sample = compaction ?? ledger?.last;
	if (!ledger || !sample) return { state: "no observation", leftMs: null, ratio: null, lifetimes: [] };
	const total = sample.read + sample.write + sample.fresh;
	const ratio = total ? sample.read / total : null;
	if (compaction) {
		return {
			state: "compacted",
			leftMs: null,
			ratio,
			lifetimes: [],
			sample,
			compacted: { before: sample.tokensBefore, after: sample.tokensAfter },
		};
	}
	const without = (state: Status["state"]): Status => ({ state, leftMs: null, ratio, lifetimes: [], sample });
	if (sample.read + sample.write === 0) return without("uncached");
	const resolved = resolveCreation(ledger, sample, now);
	if (!resolved) return without("TTL not reported");
	const anchor = Math.max(ledger.touchedAt ?? sample.startedAt, pendingAt ?? 0);
	const parts: Omit<Lifetime, "leftMs">[] = [
		{ ttl: "5m", ttlMs: TTL_MS["5m"], tokens: resolved.creation.fiveMinute },
		{ ttl: "1h", ttlMs: TTL_MS["1h"], tokens: resolved.creation.oneHour },
	];
	// A declared lifetime that is not 5m or 1h (e.g. a provider's 10-minute cache).
	const declared = ledger.declaredTtlMs ?? sample.declaredTtlMs;
	if (resolved.basis === "declared" && declared && declared !== TTL_MS["5m"] && declared !== TTL_MS["1h"]) {
		parts.splice(0, 2, { ttl: "5m", ttlMs: declared, tokens: Math.max(1, sample.read + sample.write) });
	}
	const lifetimes = parts
		.filter((p) => p.tokens > 0)
		.map((p) => ({ ...p, leftMs: Math.max(0, Math.min(p.ttlMs, anchor + p.ttlMs - now)) }));
	// A mixed cache is only fully warm until its shortest-lived portion expires.
	const leftMs = lifetimes.length ? Math.min(...lifetimes.map((p) => p.leftMs)) : 0;
	return {
		state: leftMs ? "warm" : "expired",
		leftMs,
		ratio,
		lifetimes,
		ttl: lifetimes.map((p) => ttlLabel(p.ttlMs)).join("+"),
		basis: resolved.basis,
		sample,
	};
}

export function ttlLabel(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${Math.round(ms / 1000)}s`;
}

/** Prices as multiples of the model's input price. */
export interface Prices {
	read: number;
	output: number;
	fiveMinute?: number;
	oneHour?: number;
	/** Human-readable source, e.g. "pi model registry". */
	source?: string;
	/** Listing that matched, e.g. "anthropic/claude-opus-5-5". */
	listing?: string;
}

const multiple = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function validPrices(value: any): value is Prices {
	return (
		!!value &&
		typeof value === "object" &&
		multiple(value.read) &&
		multiple(value.output) &&
		(value.fiveMinute === undefined || multiple(value.fiveMinute)) &&
		(value.oneHour === undefined || multiple(value.oneHour))
	);
}

function writePrice(prices: Prices, oneHour: boolean): number {
	const fiveMinute = Math.max(1, prices.fiveMinute ?? 1);
	return oneHour ? Math.max(fiveMinute, prices.oneHour ?? fiveMinute) : fiveMinute;
}

/**
 * How many more keepalives to send before the next real request.
 * `limit` undefined uses prices: keep warming while the keepalives since the
 * last request, plus one more, cost less than writing the cached prefix again.
 * Returns null when there is nothing to warm.
 */
export function keepalivesLeft(
	ledger: Ledger | undefined,
	prices: Prices | null | undefined,
	limit?: number,
	oneHour = false,
): number | null {
	const last = ledger?.last;
	const prefix = last ? last.read + last.write : 0;
	if (!ledger || !last || !prefix) return null;
	if (limit !== undefined) return limit === Infinity ? Infinity : count(limit) ? Math.max(0, limit - ledger.keepalives.length) : 0;
	if (!validPrices(prices)) return 0;
	const write = writePrice(prices, oneHour || (!!ledger.creation?.oneHour && !ledger.creation.fiveMinute));
	const cost = (s: Sample) => {
		const hourTokens = s.creation?.oneHour ?? (s.requested === "1h" ? s.write : 0);
		return s.read * prices.read + (s.write - hourTokens) * writePrice(prices, false) + hourTokens * writePrice(prices, true) + s.fresh + s.output * prices.output;
	};
	const spent = ledger.keepalives.reduce((sum, s) => sum + cost(s), 0);
	const next = ledger.keepalives.length ? cost(ledger.keepalives.at(-1)!) : prefix * prices.read + prices.output;
	if (next <= 0) return null;
	return Math.max(0, Math.floor((prefix * (write - prices.read) - spent) / next + 1e-9));
}

export function recentMisses(ledger: Ledger | undefined, now: number, windowMs = MISS_WINDOW_MS) {
	const causes = new Map<string, number>();
	let total = 0;
	let latest: number | undefined;
	for (const s of ledger?.samples ?? []) {
		const at = s.completedAt ?? s.startedAt;
		if (!s.miss || at < now - windowMs) continue;
		total++;
		latest = Math.max(latest ?? at, at);
		causes.set(s.miss, (causes.get(s.miss) ?? 0) + 1);
	}
	return { total, latest, causes: [...causes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

/** Mean of the recent real requests, so one miss shows without hiding the rest. */
export function recentUsage(ledger: Ledger | undefined) {
	const recent = ledger?.recent ?? [];
	if (!recent.length) return undefined;
	const sum = (f: "read" | "write" | "fresh") => recent.reduce((t, s) => t + s[f], 0);
	return { read: sum("read"), write: sum("write"), fresh: sum("fresh"), requests: recent.length };
}

export function usageRatio(u: { read: number; write: number; fresh: number } | undefined): number | null {
	const total = u ? u.read + u.write + u.fresh : 0;
	return total ? u!.read / total : null;
}

export function cachePercent(u: { read: number; write: number; fresh: number } | undefined): number | null {
	const total = u ? u.read + u.write + u.fresh : 0;
	return total ? Math.floor((u!.read * 100) / total) : null;
}

export function cacheGrade(u: { read: number; write: number; fresh: number } | undefined): Grade | null {
	const context = u ? u.read + u.write + u.fresh : 0;
	if (!context) return null;
	const missed = u!.write + u!.fresh;
	const budget = (percent: number, low: number, high: number) => Math.min(Math.max((context * percent) / 100, low), high);
	return missed <= budget(5, 2000, 20000) ? "good" : missed <= budget(20, 5000, 50000) ? "fair" : "poor";
}

export function lifeGrade(leftMs: number | null | undefined): Grade | null {
	if (leftMs === null || leftMs === undefined) return null;
	return leftMs > 120_000 ? "good" : leftMs > 30_000 ? "fair" : "poor";
}

const DIAL = ["○", "◔", "◑", "◕", "●"];
export function cacheDial(status: Status | undefined): string {
	if (!status?.ttl || status.leftMs === null) return "◌";
	const part = status.lifetimes.find((l) => l.leftMs === status.leftMs) ?? status.lifetimes[0];
	if (!part) return "◌";
	return DIAL[Math.min(4, Math.ceil((part.leftMs * 4) / part.ttlMs))];
}

const FILLS: Record<Grade, string> = { good: "█", fair: "▓", poor: "▒" };
export function cacheBarParts(ratio: number | null, width = 10, grade: Grade | null = null) {
	const fill = ratio === null ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * width);
	return { fill: (grade ? FILLS[grade] : "█").repeat(fill), empty: "░".repeat(width - fill) };
}

export function cacheClock(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function cacheTokens(value: number): string {
	if (value < 1000) return String(Math.round(value));
	const big = value >= 1e6;
	return `${Number((value / (big ? 1e6 : 1000)).toFixed(1))}${big ? "m" : "k"}`;
}

export function cacheGap(ms: number): string {
	const value = Math.max(0, ms);
	if (value < 1000) return `${(value / 1000).toFixed(1)}s`;
	const seconds = Math.round(value / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

export function sampleTtl(s: Sample): string | undefined {
	const c = s.creation;
	const reported = c ? [c.fiveMinute ? "5m" : "", c.oneHour ? "1h" : ""].filter(Boolean).join("+") : "";
	if (!s.requested) return reported || (s.declaredTtlMs ? ttlLabel(s.declaredTtlMs) : undefined);
	return reported && reported !== s.requested ? `${s.requested} (${reported} reported)` : s.requested;
}

const MATRIX = { good: "●", fair: "◐", poor: "○", miss: "✕", keepalive: "·", compaction: "◆" } as const;
export function sessionMatrix(ledger: Ledger | undefined): { glyph: string; tone: Grade | "quiet" }[] {
	const cells: { glyph: string; tone: Grade | "quiet" }[] = [];
	for (const s of ledger?.samples ?? []) {
		if (s.kind === "keepalive") cells.push({ glyph: MATRIX.keepalive, tone: "quiet" });
		else if (s.kind === "compaction") cells.push({ glyph: MATRIX.compaction, tone: "quiet" });
		else {
			const grade = cacheGrade(s);
			if (grade) cells.push({ glyph: s.miss ? MATRIX.miss : MATRIX[grade], tone: grade });
		}
	}
	return cells;
}

export function sessionUsage(ledger: Ledger | undefined) {
	const real = (ledger?.samples ?? []).filter((s) => s.kind === "real" && s.read + s.write + s.fresh > 0);
	if (!real.length) return undefined;
	const sum = (list: Sample[]) =>
		list.reduce((t, s) => ({ read: t.read + s.read, write: t.write + s.write, fresh: t.fresh + s.fresh }), { read: 0, write: 0, fresh: 0 });
	const last = real.slice(-RATE_REQUESTS);
	return { session: { ...sum(real), requests: real.length }, recent: { ...sum(last), requests: last.length } };
}

/** "100k", "60000", "1m" → tokens. */
export function parseTokens(value: unknown): number | undefined {
	const match = /^([1-9]\d*(?:\.\d+)?)\s*([km]?)$/.exec(String(value ?? "").trim().toLowerCase());
	if (!match) return undefined;
	const tokens = Math.round(Number(match[1]) * ({ "": 1, k: 1000, m: 1_000_000 } as Record<string, number>)[match[2]]);
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** "default" → undefined, "infinite" → Infinity, "12" → 12. */
export function parseLimit(value: unknown): number | undefined {
	const text = String(value ?? "").trim().toLowerCase();
	if (text === "infinite") return Infinity;
	return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}
