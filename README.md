# pi-keepalive

Prompt-cache controller for pi, ported from the Keepalive mod in
[agent-router](https://github.com/alexandernicholson/agent-router/tree/main/keepalive).
It shows how long the conversation's prompt cache has left, lets you choose the
cache TTL sent to Anthropic (5m or 1h) per session, and uses a fixed **30-minute
horizon for GPT-5.6+ OpenAI Responses and Codex**. All supported providers use the
same `off`, `warm`, `compact`, and `warmcomp` upkeep rules.

## Install

Requires pi 1.0 or newer. Tested with pi 1.0.2.

```bash
pi install git:github.com/johnnyshields/pi-keepalive
```

Then run `/reload` or restart pi. New sessions use **`warmcomp` by default**:
price-bounded keepalives followed by compaction for conversations at or above
100k tokens. **Keepalives and compactions are billable provider requests.**
Use `/keepalive mode off` to disable upkeep for the current session, or set
`cache_upkeep` to `off` in `/keepalive-settings` to change the default.
Explicit settings and saved session overrides are preserved.

For a local checkout:

```bash
pi install /path/to/pi-keepalive
# Or try it for one session:
pi -e /path/to/pi-keepalive/index.ts
```

Do not load both this package and a separate copy in
`~/.pi/agent/extensions/keepalive/`, or another idle cache-warming plugin.
Competing `cache_warming_decision` handlers can override each other.

## Cache bar

```text
[ ◕ ] ⬥ warm TTL 5m ██████████ 96% ✕ 2 prefix · ETA ~3:44 · read 148.1k · write 5.7k · new 2 · ↻ 11 ➜ comp
```

The bar sits above the editor and shows:

- **Dial:** time left on the cache, in quarters of the TTL.
- **Upkeep mode.**
- **TTL:** the selected Anthropic TTL or fixed OpenAI horizon.
- **Hit rate** over the last 10 real requests. Keepalives and compactions don't count.
- **Recent misses** and their causes: `prefix`, `expired`, `model`, `TTL`, or `cache`.
- **Countdown.**
- **The last request's tokens:** read from cache, written to cache, and sent uncached.
- **What upkeep does next:** `↻ N` keepalives left, then `➜ comp` (compact).

In fullscreen mode you can click the dial (opens the dashboard), the mode (cycles it), the Anthropic TTL (toggles it) and the miss chip (opens the dashboard filtered to misses).

The countdown starts when the latest request that read or wrote the cache was dispatched. It takes the TTL from the first of these that is available:

1. **Reported:** Anthropic's `usage.cache_creation` 5m/1h breakdown.
2. **Declared:** a provider/model policy or the model's `promptCache` lifetime. GPT-5.6+ Responses/Codex use 30m; older models continue to use their declared lifetimes. OpenAI counters report reads/writes, not the remaining lifetime, so this countdown is labelled declared rather than reported.
3. **Not reported:** no countdown, and upkeep does nothing.

## Commands and keys

| | |
|---|---|
| `/keepalive` | Dashboard: hit rate now and over the session, one dot per request, misses, TTL source, upkeep plan, price source, pi warmer status, request history (filter with `tab`; `m` mode, `t` TTL, `esc` close). |
| `/keepalive mode <off\|warm\|compact\|warmcomp>` | Upkeep for this session (also `ctrl+alt+k`). |
| `/keepalive ttl <5m\|30m\|1h\|default>` | Anthropic TTL choice (also `ctrl+alt+l`); `30m` confirms the fixed OpenAI horizon. |
| `/keepalive status` | Text summary; works in RPC/print mode. |
| `/keepalive-settings` | Global defaults (saved under `"keepalive"` in `~/.pi/agent/settings.json`). |

Choices made with the commands last for the session, including after a reload or resume (stored as session entries). A new session starts from the settings.

## Upkeep modes

Each mode acts `upkeep_lead_seconds` (default 30) before the TTL ends. It acts only while pi is idle, at most once per countdown, and only with a reported or declared TTL.

| Mode | Action |
|---|---|
| `off` | Nothing is sent. |
| `warm` | Replay the cached prefix before expiry. Anthropic uses a one-token cap; OpenAI uses the cache-preserving replay described below. Reads, unexpected writes, uncached input and output count against the price-based budget. |
| `compact` | `ctx.compact()` if the conversation is at or over `compact_threshold` (default 100k). Smaller conversations are left to expire. |
| `warmcomp` (default) | Keepalives until the keepalive limit, then compact as in `compact`. |

**Keepalive limit** (`keepalive_limit`):

- `default`: keep warming while the keepalives since your last request, plus one more, cost less than rewriting the cached prefix. With read priced at 0.1× input and writes at 1.25× that's 11 keepalives, about 55 idle minutes on a 5m TTL. A 1h cache is priced at a 2× write.
- a whole number: exactly that many.
- `infinite`: never stops, never compacts.

**Keepalive replay details:**

- **Budget thinking.** Models that use budget-based thinking (e.g. Haiku 4.5) keep their `budget_tokens`, because the cache key depends on it. The stream is aborted as soon as `message_start` reports usage. Providers may bill tokens generated before cancellation that the stream did not report; displayed spend is an estimate.
- **Real turns take priority.** Starting a real turn cancels an in-flight keepalive. Model/thinking changes, branch navigation, compaction and shutdown invalidate the captured request. Late replies cannot update another session's ledger.
- **No cold replays.** Expired caches, disabled cache markers, queued work, active requests and in-progress compactions cannot trigger a keepalive. Safety checks run again after an asynchronous price lookup.
- **Per-session budgets.** There is no cross-session concurrency or spending cap.
- **OpenAI GPT-5.6+ Responses/Codex.** Keep the existing input, instructions, tool declarations, output schema, reasoning settings and cache key unchanged, then append a tiny maintenance request. It never enters the session conversation, and no client-side tool calls are executed. Stateful `previous_response_id` requests and server-executed tools are not replayed. Explicit-only caching without breakpoints remains disabled.
- **OpenAI output and cost.** Public Responses replays use a 16-token cap when the successful request demonstrated support for that field. Codex/ChatGPT sign-in replays omit unsupported output-limit and retention fields, and use a separate SSE request rather than disturbing the live WebSocket conversation. Budget calculations include the previous request's uncached input, reserve 64 input tokens for the suffix and 16 output tokens for capped requests, or **256 estimated output tokens for uncapped requests**. Actual reads, writes, fresh input and all output (including reasoning) reconcile the spend. Codex generation is not hard-capped: a single probe can exceed the estimate or the remaining price budget. Missing billing usage exhausts the default price budget until a real turn; numeric limits count attempts. Cancellation/reload cannot make an unfinished probe look free.
- **Other APIs/older OpenAI models.** Countdown and compaction use declared lifetimes; keepalive replay is not implemented for those models.

**Compaction in pi.** pi's compaction prompt does not reuse the conversation's cache. Compacting before expiry saves on your return (a much smaller context to rewrite), not on the compaction itself. Compaction **does not delete the saved transcript**: pi appends a summary and changes model context. Its TUI redraws only the retained context, so older messages disappear from the normal chat view, but remain accessible through `/tree` and `/export`. `compaction.keepRecentTokens` (pi default 20k) controls verbatim model context, not preservation of all visible chat history. This extension does not patch pi's transcript renderer.

## TTL

- **Anthropic defaults.** The TTL is `cache_ttl` / `subagent_cache_ttl`. Their `default` value follows pi: 1h with `PI_CACHE_RETENTION=long`, otherwise 5m.
- **OpenAI GPT-5.6+ defaults.** These models use a fixed 30m policy, regardless of Anthropic TTL settings or saved 5m/1h choices. Upkeep runs at 29:30 by default. See [OpenAI's cache documentation](https://developers.openai.com/api/docs/guides/prompt-caching). The Codex horizon follows that model policy; it is not a retention setting sent to the ChatGPT endpoint.
- **How it's applied.** The extension rewrites `cache_control.ttl` in the outgoing Anthropic payload (`before_provider_request`), so the choice applies to the next request and its keepalives.
- **Request controls.** Anthropic models with `compat.supportsLongCacheRetention: false` are left alone. Public OpenAI Responses requests can use `prompt_cache_options.ttl: "30m"`; Codex/ChatGPT sign-in receives no extra retention fields. OpenAI does not get Anthropic's 5m/1h selector.
- **Subagents.** Children have the same warming, compaction, budgets and native-warmer coordination as the parent when this extension is loaded. They inherit `cache_upkeep`, use `subagent_cache_ttl`, and have no cache bar. Each child has an independent ledger and budget, including when its context was forked from the parent; idle upkeep does not keep its process alive.

1h writes cost 2× input instead of 1.25×. The choice applies to subsequent requests; existing entries may still be read with their original TTL. The countdown follows reported write metadata rather than assuming a toggle rewrote the cache.

### Loading in pi-subagents

Background children normally discover installed extensions and are identified by
`PI_SUBAGENT_CHILD=1`. Foreground children run inside the parent process and do
**not** inherit ambient extensions. Use the explicit `child.ts` entry point for
those children; it applies the subagent TTL without changing process-wide environment.

In an agent's frontmatter:

```yaml
subagentOnlyExtensions: /absolute/path/to/pi-keepalive/child.ts
```

Or set a shared default in pi's `settings.json` (preserving any existing entries):

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/pi-keepalive/child.ts"]
  }
}
```

Use the child entry point as the **only** copy in that child's extension list.
If background ambient discovery would also load `index.ts`, use an explicit
`extensions` allowlist containing `child.ts` instead of adding a second copy.
Per-agent extension overrides and capability ceilings still apply. External CLI
agents are not pi sessions and cannot load this extension.

## pi's built-in cache warmer

pi's own `cacheWarming` (default `streaming`) refreshes the cache during active runs, e.g. during a long build. Keepalive leaves that alone, with two exceptions:

- **Idle refreshes:** when an upkeep mode is on, keepalive vetoes pi's idle refreshes (`cache_warming_decision` → `stop`) so the cache is never warmed twice.
- **TTL schedule mismatches:** if the selected Anthropic TTL differs from `PI_CACHE_RETENTION`, or a GPT-5.6+ OpenAI model declares something other than 1800 seconds for the active tier, keepalive vetoes native refreshes. A native 5m schedule would over-refresh a 1h entry; a native 1h schedule could replay an expired 5m entry. To retain native streaming upkeep, keep the two settings aligned.

pi's warmer refreshes appear in the history as `pi warm`.

pi's warmer needs a declared `promptCache` lifetime on the model: `"promptCache": { "short": 300, "long": 3600 }` for Anthropic, or **`"promptCache": { "short": 1800, "long": 1800 }` for GPT-5.6+ OpenAI**. Set the latter using provider `modelOverrides` in `models.json`, so both pi's active warmer and keepalive agree. Older models must retain their own retention policy.

## Prices

Keepalive budgets use prices as multiples of the model's input price. The sources are tried in order:

1. **pi's model registry** (`models.json` / built-in catalog cost), the prices pi bills the session with, including context tiers.
2. **Anthropic's prompt-caching table** (built in, checked 2026-10-05).
3. **[models.dev](https://models.dev).** Downloaded at most daily to `~/.pi/agent/keepalive/models-dev.json`, with ETag caching and a shared lease. Never downloaded with `PI_OFFLINE` set or `models_dev: false`. Names match only when every family word and version number agrees.

## Settings

```json
"keepalive": {
  "cache_ttl": "default",
  "subagent_cache_ttl": "default",
  "cache_upkeep": "warmcomp",
  "keepalive_limit": "default",
  "compact_threshold": "100k",
  "upkeep_lead_seconds": 30,
  "models_dev": true,
  "show_bar": true
}
```

A trusted project can override these values in `.pi/settings.json`. Untrusted projects are ignored, so a cloned repo can't turn on billed keepalives.

## Storage

Each request is stored as a `keepalive-sample` custom session entry. Entries hold only token counts, timestamps, model id and TTL metadata, never prompt text. OpenAI attempts start with unknown billing usage and reconcile under the same sample ID; restoration deduplicates those entries. Unresolved costs are shown as unpriced, not zero.

## Not ported

Claude Code-specific parts of the original are left out:

- agent / teammate trees and split-pane teammate upkeep;
- the delayed transcript TTL recovery (pi reports usage directly);
- migration from Agent Router 0.16.

## Tests

Unit tests use Node's built-in TypeScript support (Node 22.18+); no install is required.
They cover cache accounting, pricing tiers and catalog failures, settings/trust
and permissions, narrow-terminal rendering, async races and both subagent entry
paths. Host/provider shims and temporary directories prevent tests from loading
credentials, sending billable requests or modifying real pi settings.

```bash
npm test
# Or:
node --test tests/*.test.ts
```

### Real foreground/background runtime tests

A separate integration suite uses the real pi SDK and **pi-subagents child-session
factory**, without the unit-test host shims. Foreground fixtures host a parent and
multiple children in one process through `child.ts`. Background fixtures run in
an isolated process, use `PI_SUBAGENT_CHILD=1`, and discover the installed
extension normally. Both paths exercise Anthropic, OpenAI Responses, and Codex and verify:

- child TTLs without changing the parent's TTL or process environment;
- forked parent state is not treated as the child's cache ledger;
- byte-identical cached-prefix replay, with no synthetic conversation messages;
- separate child budgets and resetting only the child that receives a real turn;
- shutdown aborts an in-flight request and prevents late ledger writes;
- actual SDK compaction runs once after the budget, then upkeep stops;
- every original saved chat message survives compaction.

CI runs both suites on Node 22 and 24. Integration dependencies are pinned and
installed outside the checkout; they are not plugin runtime dependencies:

```bash
test_host="$(mktemp -d)"
npm install --prefix "$test_host" --ignore-scripts --no-audit --no-fund \
  @earendil-works/pi-coding-agent@1.0.2 pi-subagents@0.76.0
PI_KEEPALIVE_PI_ROOT="$test_host/node_modules/@earendil-works/pi-coding-agent" \
PI_KEEPALIVE_SUBAGENTS_ROOT="$test_host/node_modules/pi-subagents" \
  npm run test:integration
rm -rf "$test_host"
```

Setup downloads dependencies from npm. The tests themselves use a loopback-only
fake Anthropic/Responses/Codex SSE endpoints (including Codex compression), reject external fetches, discard inherited
credentials, and use temporary agent directories. They exercise the native child
session boundary, not external CLI agents or the full workflow orchestration UI.

## License and attribution

MIT. Ported from Alexander Nicholson's Agent Router Keepalive controller.
See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the retained
upstream license.
