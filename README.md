# pi-keepalive

Prompt-cache controller for pi, ported from the Keepalive mod in
[agent-router](https://github.com/alexandernicholson/agent-router/tree/main/keepalive).
It shows how long the conversation's prompt cache has left, lets you choose the
cache TTL sent to Anthropic (5m or 1h) per session, and can keep an idle cache
from expiring.

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
[ ◕ ] ⬥ warm TTL 5m ██████████ 96% ✕ 2 prefix · ETA ~3:44 · read 148.1k · write 5.7k · new 2 · ↻11 ➜ cmpt
```

The bar sits above the editor and shows:

- **Dial:** time left on the cache, in quarters of the TTL.
- **Upkeep mode.**
- **TTL** the session sends.
- **Hit rate** over the last 10 real requests. Keepalives and compactions don't count.
- **Recent misses** and their causes: `prefix`, `expired`, `model`, `TTL`, or `cache`.
- **Countdown.**
- **The last request's tokens:** read from cache, written to cache, and sent uncached.
- **What upkeep does next:** `↻N` keepalives left, then `➜ cmpt` (compact).

In fullscreen mode you can click the dial (opens the dashboard), the mode (cycles it), the TTL (toggles it) and the miss chip (opens the dashboard filtered to misses).

The countdown starts when the latest request that read or wrote the cache was dispatched. It takes the TTL from the first of these that is available:

1. **Reported:** Anthropic's `usage.cache_creation` 5m/1h breakdown.
2. **Declared:** the model's `promptCache` lifetime in `models.json`. This is how OpenAI/Codex caches get a countdown.
3. **Not reported:** no countdown, and upkeep does nothing.

## Commands and keys

| | |
|---|---|
| `/keepalive` | Dashboard: hit rate now and over the session, one dot per request, misses, TTL source, upkeep plan, price source, pi warmer status, request history (filter with `tab`; `m` mode, `t` TTL, `esc` close). |
| `/keepalive mode <off\|warm\|compact\|warmcomp>` | Upkeep for this session (also `ctrl+alt+k`). |
| `/keepalive ttl <5m\|1h\|default>` | TTL for this session (also `ctrl+alt+l`). |
| `/keepalive status` | Text summary; works in RPC/print mode. |
| `/keepalive-settings` | Global defaults (saved under `"keepalive"` in `~/.pi/agent/settings.json`). |

Choices made with the commands last for the session, including after a reload or resume (stored as session entries). A new session starts from the settings.

## Upkeep modes

Each mode acts `upkeep_lead_seconds` (default 30) before the TTL ends. It acts only while pi is idle, at most once per countdown, and only with a reported or declared TTL.

| Mode | Action |
|---|---|
| `off` | Nothing is sent. |
| `warm` | A keepalive: the last request replayed exactly with a one-token output cap. A cache hit reads and refreshes the cached prefix. Unexpected provider misses can still incur writes; these count against the price-based budget. |
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
- **Anthropic Messages only.** Keepalives work only on Anthropic Messages APIs. Elsewhere `warmcomp` goes straight to compacting.

**Compaction in pi.** pi's compaction prompt does not reuse the conversation's cache. Compacting before expiry saves on your return (a much smaller context to rewrite), not on the compaction itself.

## TTL

- **What `default` means.** The TTL is `cache_ttl` / `subagent_cache_ttl`. Their `default` value follows pi: 1h with `PI_CACHE_RETENTION=long`, otherwise 5m.
- **How it's applied.** The extension rewrites `cache_control.ttl` in the outgoing Anthropic payload (`before_provider_request`), so the choice applies to the next request and its keepalives.
- **Where it doesn't apply.** Models that set `compat.supportsLongCacheRetention: false` are left alone, and so are non-Anthropic APIs.
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
- **TTL schedule mismatches:** if the selected TTL differs from `PI_CACHE_RETENTION`, keepalive vetoes native refreshes. A native 5m schedule would over-refresh a 1h entry; a native 1h schedule could replay an expired 5m entry. To retain native streaming upkeep, keep the two settings aligned.

pi's warmer refreshes appear in the history as `pi warm`.

pi's warmer needs a declared `promptCache` lifetime on the model, for example `"promptCache": { "short": 300, "long": 3600 }` in `models.json`.

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

Each request is stored as a `keepalive-sample` custom session entry. Entries hold only token counts, timestamps, model id and TTL metadata, never prompt text.

## Not ported

Claude Code-specific parts of the original are left out:

- agent / teammate trees and split-pane teammate upkeep;
- the delayed transcript TTL recovery (pi reports usage directly);
- migration from Agent Router 0.16.

## Tests

Tests use Node's built-in TypeScript support (Node 22.18+); no install is required.
They cover cache accounting, pricing tiers and catalog failures, settings/trust
and permissions, narrow-terminal rendering, async races and both subagent entry
paths. Host/provider shims and temporary directories prevent tests from loading
credentials, sending billable requests or modifying real pi settings.

```bash
npm test
# Or:
node --test tests/*.test.ts
```

## License and attribution

MIT. Ported from Alexander Nicholson's Agent Router Keepalive controller.
See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the retained
upstream license.
