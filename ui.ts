/**
 * Cache bar (widget above the editor) and /keepalive dashboard rendering.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	cacheBarParts,
	cacheClock,
	cacheDial,
	cacheGap,
	cacheGrade,
	cachePercent,
	cacheTokens,
	type Grade,
	type Ledger,
	lifeGrade,
	type Prices,
	recentMisses,
	recentUsage,
	type Sample,
	sampleTtl,
	sessionMatrix,
	sessionUsage,
	type Status,
	type Ttl,
	type Upkeep,
	usageRatio,
	MISS_FRESH_MS,
} from "./cache.ts";

export interface View {
	now: number;
	model?: string;
	ledger: Ledger;
	status: Status;
	/** null: this session has no upkeep (subagent child). */
	mode: Upkeep | null;
	ttl: { value: Ttl; source: string; chosen: boolean; supported: boolean };
	/** Keepalives left before stopping/compacting; null when nothing to warm; Infinity for infinite. */
	left: number | null;
	/** warmcomp/compact will compact this conversation (it is over the threshold). */
	compactable: boolean;
	limit?: number;
	threshold: number;
	leadMs: number;
	prices?: Prices | null;
	pricesPending: boolean;
	replay: { ok: boolean; reason?: string };
	pending: boolean;
	piWarming: string;
	spend?: string;
	notes: string[];
}

type Tone = Grade | "warm" | "compact" | "quiet" | "accent";

const PALETTE: Record<"dark" | "light", Record<Exclude<Tone, "quiet" | "accent">, string>> = {
	dark: { good: "#19affe", fair: "#fadf27", poor: "#fe626c", warm: "#12efc6", compact: "#8a74ff" },
	light: { good: "#0268d0", fair: "#9d580c", poor: "#7a0d3f", warm: "#0b8a6c", compact: "#5d05a4" },
};

const colorCache = new Map<string, ReturnType<typeof parseColor>>();
function paint(theme: Theme, tone: Tone | null | undefined, text: string, bold = false): string {
	if (!text) return text;
	if (!tone) return text;
	if (tone === "quiet") return theme.fg("dim", text);
	if (tone === "accent") return theme.style(text, { fg: "accent", bold });
	const hex = PALETTE[theme.appearance === "light" ? "light" : "dark"][tone];
	let color = colorCache.get(hex);
	if (!color) colorCache.set(hex, (color = parseColor(hex)));
	return theme.style(text, { fg: color, bold });
}

const MARKS: Record<Upkeep, Tone[]> = { off: [], warm: ["warm"], compact: ["compact"], warmcomp: ["warm", "compact"] };

function modeChip(theme: Theme, mode: Upkeep | null): string {
	if (mode === null) return theme.fg("dim", "–");
	if (mode === "off") return theme.fg("dim", "⬦ off");
	return MARKS[mode].map((t) => paint(theme, t, "⬥")).join("") + " " + mode;
}

function bar(theme: Theme, ratio: number | null, grade: Grade | null, width = 10): string {
	const { fill, empty } = cacheBarParts(ratio, width, grade);
	return paint(theme, grade ?? "quiet", fill) + theme.fg("dim", empty);
}

function percentText(theme: Theme, u: { read: number; write: number; fresh: number } | undefined): string {
	const p = cachePercent(u);
	return p === null ? theme.fg("dim", "–") : paint(theme, cacheGrade(u), `${p}%`);
}

function upkeepHint(theme: Theme, v: View): string {
	if (!v.mode || v.mode === "off" || v.status.state !== "warm") return "";
	const warms = v.mode === "warm" || v.mode === "warmcomp";
	const parts: string[] = [];
	if (warms && v.replay.ok && v.left !== null) {
		if (v.left === Infinity) parts.push(paint(theme, "warm", "↻∞"));
		else if (v.left > 0) parts.push(paint(theme, "warm", `↻${v.left}`));
	}
	if ((v.mode === "compact" || v.mode === "warmcomp") && v.compactable && v.left !== Infinity) parts.push(paint(theme, "compact", "➜ cmpt"));
	return parts.join(" ");
}

export interface BarSegment {
	from: number;
	to: number;
	action: "dashboard" | "mode" | "ttl" | "misses";
}

/** One-line cache bar plus clickable segment ranges (visible columns). */
export function renderBar(theme: Theme, v: View, width: number): { line: string; segments: BarSegment[] } {
	const segments: BarSegment[] = [];
	let line = "";
	const push = (text: string, action?: BarSegment["action"]) => {
		const from = visibleWidth(line);
		line += text;
		if (action) segments.push({ from, to: visibleWidth(line), action });
	};
	const s = v.status;
	const lifeTone = lifeGrade(s.leftMs);
	push(`[ ${paint(theme, lifeTone ?? "quiet", cacheDial(s))} ]`, "dashboard");
	push(" ");
	push(modeChip(theme, v.mode), v.mode === null ? undefined : "mode");
	push(" ");
	const ttlText = v.ttl.supported ? `TTL ${v.ttl.value}` : `TTL ${s.ttl ?? "–"}`;
	push(v.ttl.supported ? theme.style(ttlText, { fg: "accent", underline: true }) : theme.fg("dim", ttlText), v.ttl.supported ? "ttl" : undefined);
	if (s.ttl && v.ttl.supported && s.basis === "reported" && s.ttl !== v.ttl.value) push(theme.fg("dim", ` · ${s.ttl} reported`));
	push(" ");
	if (s.state === "compacted") {
		const { before, after } = s.compacted ?? {};
		const sizes = before !== undefined ? ` ${cacheTokens(before)}${after !== undefined ? ` → ${cacheTokens(after)}` : ""}` : "";
		push(paint(theme, "compact", `cmpt ✓${sizes}`));
		if (s.sample) push(" " + bar(theme, s.ratio, cacheGrade(s.sample)) + " " + percentText(theme, s.sample));
	} else {
		const recent = recentUsage(v.ledger) ?? s.sample;
		push(bar(theme, usageRatio(recent), cacheGrade(recent)) + " " + percentText(theme, recent));
	}
	const misses = recentMisses(v.ledger, v.now);
	if (misses.total) {
		const fresh = misses.latest !== undefined && v.now - misses.latest < MISS_FRESH_MS;
		const words = misses.causes.slice(0, 2).map(([cause]) => cause.split(" ")[0]).join(" ");
		const chip = `✕ ${misses.total} ${words}`;
		push(" ");
		push(fresh ? paint(theme, "fair", chip) : theme.fg("dim", chip), "misses");
	}
	const tail: string[] = [];
	if (v.pending) tail.push("request in flight");
	else if (s.state === "warm" && s.leftMs !== null) {
		const eta = paint(theme, lifeTone, `ETA ~${cacheClock(s.leftMs)}`);
		tail.push(s.basis === "awaiting" ? `${eta} ${theme.fg("dim", "(awaiting report)")}` : s.basis === "declared" ? `${eta} ${theme.fg("dim", "(declared)")}` : eta);
	} else if (s.state === "expired") tail.push(paint(theme, "poor", "expired"));
	else if (s.state !== "compacted") tail.push(theme.fg("dim", s.state));
	if (s.sample && s.state !== "compacted") {
		tail.push(`read ${cacheTokens(s.sample.read)}`, `write ${cacheTokens(s.sample.write)}`, `new ${cacheTokens(s.sample.fresh)}`);
	}
	const hint = upkeepHint(theme, v);
	if (hint) tail.push(hint);
	if (tail.length) push(theme.fg("dim", " · ") + tail.join(theme.fg("dim", " · ")));
	return { line: truncateToWidth(line, width), segments };
}

// ------------------------------------------------------------------ dashboard

export const REQUEST_FILTERS = ["all", "real", "keepalives", "compactions", "misses"] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

function filterSample(s: Sample, f: RequestFilter) {
	if (f === "all") return true;
	if (f === "real") return s.kind === "real";
	if (f === "keepalives") return s.kind === "keepalive";
	if (f === "compactions") return s.kind === "compaction";
	return !!s.miss;
}

function pad(text: string, width: number, right = false): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	return right ? " ".repeat(width - w) + text : text + " ".repeat(width - w);
}

function describeUpkeep(v: View): string {
	if (v.mode === null) return "none in a subagent session";
	if (v.mode === "off") return "off · nothing is sent";
	const warms = v.mode === "warm" || v.mode === "warmcomp";
	const parts: string[] = [];
	if (warms && !v.replay.ok) parts.push(`keepalives unavailable (${v.replay.reason})`);
	else if (warms) {
		if (v.left === null) parts.push("nothing to warm yet");
		else if (v.left === Infinity) parts.push("keepalives until your next request");
		else if (v.limit === undefined && !v.prices && !v.pricesPending) parts.push("no price found · no keepalives with the default limit");
		else parts.push(`${v.left} keepalive${v.left === 1 ? "" : "s"}`);
	}
	if (v.mode !== "warm" && v.left !== Infinity) {
		parts.push(v.compactable ? `${warms ? "then " : ""}compact` : `${warms ? "then " : ""}expire (under ${cacheTokens(v.threshold)} compaction threshold)`);
	} else if (v.mode === "warm") parts.push("then stop");
	const sent = v.ledger.keepalives.length;
	return `${v.mode} · ${parts.join(", ")}${sent ? ` · ${sent} sent since your last request` : ""} · acts ${Math.round(v.leadMs / 1000)}s before expiry`;
}

function describePrices(v: View): string {
	if (v.pricesPending) return "looking up…";
	const p = v.prices;
	if (!p) return v.limit === undefined ? "no price found" : "not needed (numeric limit)";
	const x = (n: number | undefined) => (n === undefined ? "–" : `${Number(n.toFixed(3))}×`);
	return `${p.source}${p.listing ? ` (${p.listing})` : ""} · read ${x(p.read)} · write ${x(p.fiveMinute ?? 1)} · 1h ${x(p.oneHour)} · output ${x(p.output)} of input`;
}

export function renderDashboard(theme: Theme, v: View, filter: RequestFilter, width: number): string[] {
	const lines: string[] = [];
	const label = (text: string) => theme.fg("muted", pad(text, 11));
	lines.push(theme.style(`Prompt cache · main conversation${v.model ? ` · ${v.model}` : ""}`, { fg: "accent", bold: true }));
	const usage = sessionUsage(v.ledger);
	if (usage) {
		const r = usage.recent;
		const s = usage.session;
		lines.push(`${label("Now")}${bar(theme, usageRatio(r), cacheGrade(r))} ${percentText(theme, r)} over the last ${r.requests} request${r.requests === 1 ? "" : "s"}`);
		lines.push(
			`${label("Session")}${bar(theme, usageRatio(s), cacheGrade(s))} ${percentText(theme, s)} over ${s.requests} request${s.requests === 1 ? "" : "s"} · read ${cacheTokens(v.ledger.totals.read)} · write ${cacheTokens(v.ledger.totals.write)} · new ${cacheTokens(v.ledger.totals.fresh)}`,
		);
	} else lines.push(theme.fg("dim", "No requests observed in this session yet."));

	const cells = sessionMatrix(v.ledger);
	if (cells.length) {
		const per = Math.max(10, width - 2);
		const rows: string[] = [];
		for (let i = 0; i < cells.length; i += per) rows.push(cells.slice(i, i + per).map((c) => paint(theme, c.tone, c.glyph)).join(""));
		const shown = rows.slice(-4);
		const hidden = cells.length - shown.reduce((n, _r, i) => n + Math.min(per, cells.length - (rows.length - shown.length + i) * per), 0);
		if (hidden > 0) lines.push(theme.fg("dim", `… ${hidden} older`));
		lines.push(...shown);
		lines.push(theme.fg("dim", "One dot per request, oldest first: ● good ◐ fair ○ poor ✕ miss · keepalive ◆ compaction"));
	}

	const misses = recentMisses(v.ledger, v.now);
	if (misses.total) {
		const causes = misses.causes.map(([c, n]) => `${n} ${c}`).join(", ");
		lines.push(paint(theme, "fair", `✕ ${misses.total} cache miss${misses.total === 1 ? "" : "es"} in the last 15 min: ${causes} · latest ${cacheClock(v.now - (misses.latest ?? v.now))} ago`));
	}

	lines.push("");
	const s = v.status;
	const ttlState =
		s.state === "warm"
			? `${s.ttl}${s.basis === "reported" ? " reported" : s.basis === "declared" ? " declared in models.json" : " requested, awaiting report"} · ETA ~${cacheClock(s.leftMs ?? 0)}`
			: s.state;
	lines.push(`${label("TTL")}${v.ttl.value}${v.ttl.supported ? "" : " (not settable for this API)"} · ${v.ttl.source} · ${ttlState}`);
	lines.push(`${label("Upkeep")}${modeChip(theme, v.mode)} · ${describeUpkeep(v).replace(/^\w+ · /, "")}`);
	lines.push(`${label("Prices")}${describePrices(v)}`);
	if (v.spend) lines.push(`${label("Spent")}${v.spend}`);
	lines.push(`${label("pi warmer")}${v.piWarming}`);
	for (const note of v.notes) lines.push(theme.fg("warning", `! ${note}`));

	lines.push("");
	lines.push(
		`${label("Requests")}${REQUEST_FILTERS.map((f) => (f === filter ? theme.style(`[ ${f} ]`, { fg: "accent", bold: true }) : theme.fg("dim", f))).join(" ")}`,
	);
	const shown = v.ledger.samples.filter((x) => filterSample(x, filter)).slice(-30);
	if (!shown.length) lines.push(theme.fg("dim", "  (none)"));
	else {
		lines.push(
			theme.fg(
				"muted",
				`${pad("request", 11)} ${pad("hit", 11)} ${pad("TTL", 16)} ${pad("miss", 15)} ${pad("read", 7, true)} ${pad("write", 7, true)} ${pad("new", 6, true)} ${pad("out", 6, true)}  model`,
			),
		);
		let prev: Sample | undefined;
		for (const x of shown) {
			if (prev) lines.push(theme.fg("dim", `↕ ${cacheGap(x.startedAt - (prev.completedAt ?? prev.startedAt))}`));
			const name =
				x.kind === "keepalive" ? (x.via === "pi-warmer" ? "pi warm" : "keepalive") : x.kind === "compaction" ? "compaction" : new Date(x.startedAt).toLocaleTimeString([], { hour12: false });
			const grade = cacheGrade(x);
			const pct = cachePercent(x);
			const hit = pct === null ? theme.fg("dim", pad("–", 11)) : `${bar(theme, usageRatio(x), grade, 6)} ${paint(theme, grade, pad(`${pct}%`, 4))}`;
			const sizes = x.kind === "compaction" && x.tokensBefore !== undefined ? ` ${cacheTokens(x.tokensBefore)}→${x.tokensAfter !== undefined ? cacheTokens(x.tokensAfter) : "?"}` : "";
			lines.push(
				`${pad(name + sizes, 11)} ${pad(hit, 11)} ${pad(sampleTtl(x) ?? "–", 16)} ${x.miss ? paint(theme, "fair", pad(x.miss, 15)) : pad("", 15)} ${pad(cacheTokens(x.read), 7, true)} ${pad(cacheTokens(x.write), 7, true)} ${pad(cacheTokens(x.fresh), 6, true)} ${pad(cacheTokens(x.output), 6, true)}  ${theme.fg("dim", x.model)}`,
			);
			prev = x;
		}
	}
	lines.push("");
	lines.push(theme.fg("dim", "tab/r requests filter · m upkeep mode · t TTL 5m/1h · esc close"));
	return lines.map((l) => truncateToWidth(l, width));
}

export class Dashboard {
	filter: RequestFilter;
	private scroll = 0;
	constructor(
		private theme: Theme,
		private view: () => View,
		private actions: { cycleMode(): void; toggleTtl(): void; close(): void; render(): void },
		filter: RequestFilter = "all",
	) {
		this.filter = filter;
	}
	render(width: number): string[] {
		const body = renderDashboard(this.theme, this.view(), this.filter, Math.max(20, width - 4));
		const max = Math.max(0, body.length - 40);
		this.scroll = Math.min(this.scroll, max);
		const visible = body.slice(this.scroll, this.scroll + 40);
		const border = (t: string) => this.theme.fg("borderMuted", t);
		const inner = Math.max(20, width - 4);
		return [
			border(`╭${"─".repeat(inner + 2)}╮`),
			...visible.map((l) => `${border("│")} ${pad(l, inner)} ${border("│")}`),
			border(`╰${"─".repeat(inner + 2)}╯`),
		];
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape") || data === "q") return this.actions.close();
		if (matchesKey(data, "tab") || data === "r") this.filter = REQUEST_FILTERS[(REQUEST_FILTERS.indexOf(this.filter) + 1) % REQUEST_FILTERS.length];
		else if (matchesKey(data, "shift+tab")) this.filter = REQUEST_FILTERS[(REQUEST_FILTERS.indexOf(this.filter) + REQUEST_FILTERS.length - 1) % REQUEST_FILTERS.length];
		else if (data === "m") this.actions.cycleMode();
		else if (data === "t") this.actions.toggleTtl();
		else if (matchesKey(data, "down") || data === "j") this.scroll++;
		else if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
		else return;
		this.actions.render();
	}
	invalidate() {}
}

export const GUIDE = [
	"Keepalive: prompt cache bar above the editor.",
	"  [ ◕ ] time until the cache expires (refills with each request) — /keepalive opens the dashboard.",
	"  ⬦ off / ⬥ warm / ⬥ compact / ⬥⬥ warmcomp — upkeep mode; /keepalive mode or ctrl+alt+k cycles it.",
	"    warm sends cheap keepalives before expiry (by default while they cost less than rewriting the cache; ↻ shows how many are left).",
	"    compact compacts a conversation at/over the threshold while it is still cached; warmcomp warms first, then compacts.",
	"  TTL 5m / 1h — the cache lifetime sent to the provider; /keepalive ttl or ctrl+alt+l toggles it for this session.",
	"  In fullscreen mode the dial, mode and TTL are clickable. Defaults: /keepalive-settings. Keepalives and compactions are billed.",
];
