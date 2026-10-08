/**
 * Price sources for keepalive cost decisions, asked in order:
 *   1. pi's model registry (models.json / built-in catalog) — what pi bills with
 *   2. Anthropic's prompt-caching price table (built in)
 *   3. models.dev public catalog (downloaded once a day, ETag-cached)
 *
 * Prices are returned as multiples of the model's input price.
 * Model-name matching is ported from agent-router keepalive (lib/model-match.js).
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prices, Sample } from "./cache.ts";
import { validPrices } from "./cache.ts";

export const ANTHROPIC_PRICES_URL = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing";
export const ANTHROPIC_PRICES_CHECKED = "2026-10-05";

/** provider, id, owner, input, output, cacheRead, 5m write, 1h write — $/MTok */
type Listing = [string, string, string | null, number, number, number, number | null, number | null];
export const ANTHROPIC_PRICES: Listing[] = [
	["anthropic", "claude-fable-5-1", "anthropic", 10, 50, 0.25, 12.5, 20],
	["anthropic", "claude-mythos-5-1", "anthropic", 10, 50, 0.25, 12.5, 20],
	["anthropic", "claude-fable-5", "anthropic", 10, 50, 1, 12.5, 20],
	["anthropic", "claude-mythos-5", "anthropic", 10, 50, 1, 12.5, 20],
	["anthropic", "claude-opus-5-5", "anthropic", 4, 20, 0.2, 5, 8],
	["anthropic", "claude-opus-5", "anthropic", 5, 25, 0.5, 6.25, 10],
	["anthropic", "claude-opus-4-8", "anthropic", 5, 25, 0.5, 6.25, 10],
	["anthropic", "claude-opus-4-7", "anthropic", 5, 25, 0.5, 6.25, 10],
	["anthropic", "claude-opus-4-6", "anthropic", 5, 25, 0.5, 6.25, 10],
	["anthropic", "claude-opus-4-5", "anthropic", 5, 25, 0.5, 6.25, 10],
	["anthropic", "claude-opus-4-1", "anthropic", 15, 75, 1.5, 18.75, 30],
	["anthropic", "claude-opus-4", "anthropic", 15, 75, 1.5, 18.75, 30],
	["anthropic", "claude-sonnet-5-5", "anthropic", 2, 10, 0.2, 2.5, 4],
	["anthropic", "claude-sonnet-5", "anthropic", 2, 10, 0.2, 2.5, 4],
	["anthropic", "claude-sonnet-4-6", "anthropic", 3, 15, 0.3, 3.75, 6],
	["anthropic", "claude-sonnet-4-5", "anthropic", 3, 15, 0.3, 3.75, 6],
	["anthropic", "claude-sonnet-4", "anthropic", 3, 15, 0.3, 3.75, 6],
	["anthropic", "claude-haiku-4-5", "anthropic", 1, 5, 0.1, 1.25, 2],
	["anthropic", "claude-haiku-3-5", "anthropic", 0.8, 4, 0.08, 1, 1.6],
];

// ---------------------------------------------------------------- matching

const VENDOR_WORDS = new Set(["claude", "anthropic"]);
const AGREEMENT = 0.03;

function parse(model: unknown): { key: string; date?: string } | null {
	if (typeof model !== "string") return null;
	let name = model.trim().toLowerCase();
	if (!name || name.length > 200) return null;
	name = name.replace(/\[[^\]]*\]$/, "");
	name = name.slice(name.lastIndexOf("/") + 1);
	name = name.replace(/@.*$/, "");
	name = name.replace(/-v\d+(?::\d+)?$/, "");
	name = name.replace(/^(?:[a-z][a-z-]*\.)+(?=[a-z])/, "");
	let date: string | undefined;
	name = name.replace(/(?:^|[-_.])(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})$/, (_m, y, mo, d) => {
		date = `${y}${mo}${d}`;
		return "";
	});
	const tokens = name.match(/[a-z]+|\d+/g) ?? [];
	const words = [...new Set(tokens.filter((t) => /^[a-z]/.test(t) && !VENDOR_WORDS.has(t)))].sort();
	const numbers = tokens.filter((t) => /^\d/.test(t)).map((t) => String(Number(t)));
	if (!words.length || !numbers.length) return null;
	return { key: `${words.join("-")}:${numbers.join(".")}`, date };
}

export const modelKey = (model: unknown) => parse(model)?.key ?? null;

const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const usable = (e: any[]) =>
	typeof e[0] === "string" && typeof e[1] === "string" && e[1].length <= 200 && price(e[3]) && e[3] > 0 && price(e[4]) && price(e[5]);

interface IndexedListing {
	provider: string;
	id: string;
	owner: string | null;
	date?: string;
	input: number;
	output: number;
	read: number;
	write: number | null;
	hour: number | null;
}

export function priceIndex(entries: unknown[]): Map<string, IndexedListing[]> {
	const index = new Map<string, IndexedListing[]>();
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!Array.isArray(entry) || !usable(entry)) continue;
		const [provider, id, owner, input, output, read, write, hour] = entry;
		const parsed = parse(id);
		if (!parsed) continue;
		const listing: IndexedListing = {
			provider,
			id,
			owner: typeof owner === "string" ? owner : null,
			date: parsed.date,
			input,
			output,
			read,
			write: price(write) ? write : null,
			hour: price(hour) ? hour : null,
		};
		index.set(parsed.key, [...(index.get(parsed.key) ?? []), listing]);
	}
	return index;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function matchPrices(index: Map<string, IndexedListing[]>, model: unknown): Prices | null {
	const parsed = parse(model);
	if (!parsed) return null;
	let candidates = index.get(parsed.key) ?? [];
	if (parsed.date) {
		const dated = candidates.filter((l) => l.date === parsed.date);
		if (dated.length) candidates = dated;
	}
	if (!candidates.length) return null;
	const firstParty = candidates.filter((l) => l.owner && l.provider === l.owner);
	const pool = firstParty.length ? firstParty : candidates;
	const read = (l: IndexedListing) => l.read / l.input;
	let agreed: IndexedListing[] = [];
	for (const l of pool) {
		const group = pool.filter((o) => Math.abs(read(o) - read(l)) <= AGREEMENT * Math.max(read(o), read(l)));
		if (group.length > agreed.length) agreed = group;
	}
	if (agreed.length * 3 < pool.length * 2) return null;
	const writes = agreed.filter((l) => l.write !== null).map((l) => l.write! / l.input);
	const hours = agreed.filter((l) => l.hour !== null).map((l) => l.hour! / l.input);
	const [chosen] = agreed;
	return {
		read: median(agreed.map(read)),
		...(writes.length ? { fiveMinute: median(writes) } : {}),
		...(hours.length ? { oneHour: median(hours) } : {}),
		output: median(agreed.map((l) => l.output / l.input)),
		listing: `${chosen.provider}/${chosen.id}`,
	};
}

// ---------------------------------------------------------------- sources

const anthropicIndex = priceIndex(ANTHROPIC_PRICES);

/** Prices from pi's own model definition (what pi uses to bill the session). */
function registryRates(model: any, contextTokens: number): { rates: any; threshold: number } | null {
	let rates = model?.cost;
	if (!rates || !price(rates.input) || rates.input <= 0) return null;
	let threshold = -1;
	for (const tier of Array.isArray(model.cost.tiers) ? model.cost.tiers : []) {
		if (price(tier?.inputTokensAbove) && contextTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold &&
			price(tier.input) && tier.input > 0 && price(tier.output) && price(tier.cacheRead)) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	if (!price(rates.output) || !price(rates.cacheRead)) return null;
	return { rates, threshold };
}

export function registryPrices(model: any, contextTokens = 0): Prices | null {
	const selected = registryRates(model, contextTokens);
	if (!selected) return null;
	const { rates, threshold } = selected;
	const anthropic = model.api === "anthropic-messages";
	return {
		read: rates.cacheRead / rates.input,
		output: rates.output / rates.input,
		...(price(rates.cacheWrite) && rates.cacheWrite > 0 ? { fiveMinute: rates.cacheWrite / rates.input } : {}),
		// pi bills Anthropic 1h writes at 2× input (pi-ai calculateCost).
		...(anthropic ? { oneHour: 2 } : {}),
		listing: `${model.provider}/${model.id}${threshold >= 0 ? ` (>${Math.round(threshold / 1000)}k tier)` : ""}`,
	};
}

/** Estimated USD using the same context tier as pi. Missing prices are unknown, not zero. */
export function sampleCost(model: any, sample: Sample): number | null {
	const selected = registryRates(model, sample.read + sample.write + sample.fresh);
	if (!selected || (sample.write > 0 && !price(selected.rates.cacheWrite))) return null;
	const { rates } = selected;
	const hour = model.api === "anthropic-messages" ? sample.creation?.oneHour ?? (sample.requested === "1h" ? sample.write : 0) : 0;
	const total = (sample.read * rates.cacheRead + (sample.write - hour) * (rates.cacheWrite ?? 0) + hour * 2 * rates.input +
		sample.fresh * rates.input + sample.output * rates.output) / 1e6;
	return Number.isFinite(total) && total >= 0 ? total : null;
}

export function anthropicPrices(modelId: string): Prices | null {
	return matchPrices(anthropicIndex, modelId);
}

// ---------------------------------------------------------------- models.dev

export const MODELS_DEV_URL = "https://models.dev/api.json";
const FRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
const LEASE_MS = 120_000;
const LIMIT = 32 * 1024 * 1024;

function catalogEntries(data: any): Listing[] {
	const entries: Listing[] = [];
	if (!data || typeof data !== "object" || Array.isArray(data)) return entries;
	for (const [provider, listing] of Object.entries<any>(data)) {
		const models = listing?.models;
		if (!models || typeof models !== "object" || Array.isArray(models)) continue;
		for (const [id, m] of Object.entries<any>(models)) {
			const cost = m?.cost;
			if (!cost || typeof cost !== "object") continue;
			const canonical =
				typeof m.canonical_model_id === "string" && m.canonical_model_id.includes("/") ? m.canonical_model_id.split("/")[0] : null;
			const entry: Listing = [provider, id, canonical, cost.input, cost.output, cost.cache_read, price(cost.cache_write) ? cost.cache_write : null, null];
			if (usable(entry)) entries.push(entry);
		}
	}
	return entries;
}

interface CatalogFile {
	fetchedAt?: number;
	failedAt?: number;
	etag?: string;
	entries?: Listing[];
}

async function readCatalog(file: string): Promise<CatalogFile | null> {
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function writeAtomic(file: string, value: unknown) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		await rename(tmp, file);
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

async function lease(file: string, now: number, retry = true): Promise<boolean> {
	try {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.writeFile(String(now));
		} finally {
			await handle.close();
		}
		return true;
	} catch (error: any) {
		if (error?.code !== "EEXIST" || !retry) return false;
		const content = await readFile(file, "utf8").catch(() => undefined);
		if (content === undefined) return false; // another owner may be releasing/replacing the lease
		const parsed = Number(content);
		// A newly created lock can be empty until its owner's write completes.
		const at = content.trim() && Number.isFinite(parsed) && parsed <= now
			? parsed : (await stat(file).catch(() => undefined))?.mtimeMs;
		if (at === undefined || now - at < LEASE_MS) return false;
		await unlink(file).catch(() => {});
		return lease(file, now, false);
	}
}

async function download(etag?: string): Promise<{ unchanged: true } | { entries: Listing[]; etag?: string }> {
	const response = await fetch(MODELS_DEV_URL, {
		headers: { accept: "application/json", "user-agent": "pi-keepalive", ...(etag ? { "if-none-match": etag } : {}) },
		redirect: "follow",
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 304) return { unchanged: true };
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`models.dev returned HTTP ${response.status}`);
	}
	let text = "";
	let bytes = 0;
	const decoder = new TextDecoder();
	for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
		bytes += chunk.byteLength;
		if (bytes > LIMIT) throw new Error("models.dev response exceeded its size limit");
		text += decoder.decode(chunk, { stream: true });
	}
	text += decoder.decode();
	const entries = catalogEntries(JSON.parse(text));
	if (!entries.length) throw new Error("models.dev listed no priced models");
	return { entries, etag: response.headers.get("etag") ?? undefined };
}

export interface CatalogState {
	catalog: "fresh" | "stale" | "missing";
	fetchedAt: number | null;
	index: Map<string, IndexedListing[]>;
}

/** Load (and when due, refresh) the shared models.dev price file. */
export async function modelsDevCatalog(root: string, allowNetwork: boolean, now = Date.now()): Promise<CatalogState> {
	mkdirSync(root, { recursive: true });
	const file = join(root, "models-dev.json");
	let cached = await readCatalog(file);
	const listed = (v: CatalogFile | null) => Array.isArray(v?.entries) && v.entries.some((e) => Array.isArray(e) && usable(e)) &&
		Number.isSafeInteger(v?.fetchedAt) && v!.fetchedAt! >= 0;
	const fresh = (v: CatalogFile | null) => listed(v) && now >= v!.fetchedAt! && now - v!.fetchedAt! < FRESH_MS;
	const waiting = Number.isSafeInteger(cached?.failedAt) && now >= cached!.failedAt! && now - cached!.failedAt! < RETRY_MS;
	if (!fresh(cached) && !waiting && allowNetwork) {
		const lock = join(root, "models-dev.lock");
		if (await lease(lock, now)) {
			try {
				const result = await download(listed(cached) ? cached!.etag : undefined);
				cached = "unchanged" in result ? { ...cached, fetchedAt: now, failedAt: undefined } : { fetchedAt: now, etag: result.etag, entries: result.entries };
				await writeAtomic(file, cached);
			} catch {
				cached = { ...(cached ?? {}), failedAt: now };
				await writeAtomic(file, cached).catch(() => {});
			} finally {
				await unlink(lock).catch(() => {});
			}
		}
	}
	return {
		catalog: fresh(cached) ? "fresh" : listed(cached) ? "stale" : "missing",
		fetchedAt: listed(cached) ? cached!.fetchedAt! : null,
		index: priceIndex(listed(cached) ? cached!.entries! : []),
	};
}

// ---------------------------------------------------------------- lookup

export interface PriceLookup {
	prices: Prices | null;
	checkedAt: number;
}

/**
 * Look a model up in every source, in order. `model` is a pi Model.
 * models.dev is consulted only when the earlier sources found nothing.
 */
export async function lookUpPrices(
	model: any,
	options: { root: string; allowNetwork: boolean; contextTokens?: number; useRegistry?: boolean },
): Promise<Prices | null> {
	if (options.useRegistry !== false) {
		const fromRegistry = registryPrices(model, options.contextTokens);
		if (validPrices(fromRegistry)) return { ...fromRegistry, source: "pi model registry" };
	}
	const fromTable = anthropicPrices(model?.id);
	if (validPrices(fromTable)) return { ...fromTable, source: `Anthropic pricing (checked ${ANTHROPIC_PRICES_CHECKED})` };
	try {
		const catalog = await modelsDevCatalog(options.root, options.allowNetwork);
		const fromCatalog = matchPrices(catalog.index, model?.id);
		if (validPrices(fromCatalog)) return { ...fromCatalog, source: "models.dev" };
	} catch {
		// Price lookups are best-effort.
	}
	return null;
}
