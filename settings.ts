/**
 * Keepalive settings live under the "keepalive" key of pi's settings.json
 * (global ~/.pi/agent/settings.json, overridable per project in .pi/settings.json),
 * next to pi's own settings.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseLimit, parseTokens, type Ttl, type Upkeep, UPKEEP_MODES } from "./cache.ts";

export type TtlSetting = "default" | Ttl;

export interface KeepaliveSettings {
	/** TTL the main conversation starts with. */
	cache_ttl: TtlSetting;
	/** TTL subagent sessions (pi-subagents children) start with. */
	subagent_cache_ttl: TtlSetting;
	/** Upkeep a new session starts in. */
	cache_upkeep: Upkeep;
	/** "default" (price-based), "infinite", or a whole number. */
	keepalive_limit: string;
	/** Smallest conversation compact/warmcomp compact, e.g. "100k". */
	compact_threshold: string;
	/** Seconds before expiry that upkeep acts. */
	upkeep_lead_seconds: number;
	/** Allow downloading the models.dev price catalog. */
	models_dev: boolean;
	/** Show the cache bar above the editor. */
	show_bar: boolean;
	/** Internal: the one-time guide was shown. */
	guide_shown?: boolean;
}

export const DEFAULTS: KeepaliveSettings = {
	cache_ttl: "default",
	subagent_cache_ttl: "default",
	cache_upkeep: "warmcomp",
	keepalive_limit: "default",
	compact_threshold: "100k",
	upkeep_lead_seconds: 30,
	models_dev: true,
	show_bar: true,
};

const KEY = "keepalive";
export const globalSettingsPath = () => join(getAgentDir(), "settings.json");
export const projectSettingsPath = (cwd: string) => join(cwd, ".pi", "settings.json");
export const dataDir = () => join(getAgentDir(), "keepalive");

function readJson(path: string): Record<string, any> | null {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

const ttlSetting = (v: unknown): TtlSetting | undefined => (v === "default" || v === "5m" || v === "1h" ? v : undefined);

function normalize(raw: any): Partial<KeepaliveSettings> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Partial<KeepaliveSettings> = {};
	if (ttlSetting(raw.cache_ttl)) out.cache_ttl = raw.cache_ttl;
	if (ttlSetting(raw.subagent_cache_ttl)) out.subagent_cache_ttl = raw.subagent_cache_ttl;
	if (UPKEEP_MODES.includes(raw.cache_upkeep)) out.cache_upkeep = raw.cache_upkeep;
	if (raw.keepalive_limit !== undefined) {
		const text = String(raw.keepalive_limit).trim().toLowerCase();
		if (text === "default" || parseLimit(text) !== undefined) out.keepalive_limit = text;
	}
	if (raw.compact_threshold !== undefined && parseTokens(raw.compact_threshold) !== undefined)
		out.compact_threshold = String(raw.compact_threshold).trim().toLowerCase();
	if (Number.isFinite(raw.upkeep_lead_seconds) && raw.upkeep_lead_seconds >= 5 && raw.upkeep_lead_seconds <= 600)
		out.upkeep_lead_seconds = raw.upkeep_lead_seconds;
	if (typeof raw.models_dev === "boolean") out.models_dev = raw.models_dev;
	if (typeof raw.show_bar === "boolean") out.show_bar = raw.show_bar;
	if (raw.guide_shown === true) out.guide_shown = true;
	return out;
}

/** Project settings apply only to trusted projects: a cloned repo must not be able to turn on billed keepalives. */
export function loadSettings(cwd: string, projectTrusted = false): KeepaliveSettings {
	const global = readJson(globalSettingsPath())?.[KEY];
	const project = projectTrusted ? readJson(projectSettingsPath(cwd))?.[KEY] : undefined;
	return { ...DEFAULTS, ...normalize(global), ...normalize(project) };
}

/** Write one or more keepalive settings to the global settings file (project file if it already has a keepalive key). */
export function saveSettings(cwd: string, patch: Partial<KeepaliveSettings>, projectTrusted = false): string | null {
	const projectPath = projectSettingsPath(cwd);
	const project = projectTrusted ? readJson(projectPath) : null;
	const useProject = !!project && Object.prototype.hasOwnProperty.call(project, KEY);
	const path = useProject ? projectPath : globalSettingsPath();
	const settings = useProject ? project : readJson(path);
	if (!settings) return null; // unreadable JSON: never overwrite it
	const current = settings[KEY];
	settings[KEY] = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...normalize(patch) };
	const tmp = `${path}.keepalive-${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		// The whole file may contain credentials: never broaden its permissions.
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode });
		renameSync(tmp, path);
		return path;
	} catch {
		return null;
	} finally {
		try { unlinkSync(tmp); } catch { /* renamed or never created */ }
	}
}

/** The keepalive limit as a number, Infinity, or undefined for the price-based default. */
export const limitOf = (s: KeepaliveSettings) => (s.keepalive_limit === "default" ? undefined : parseLimit(s.keepalive_limit));
export const thresholdOf = (s: KeepaliveSettings) => parseTokens(s.compact_threshold) ?? 100_000;
