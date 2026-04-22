# Claude Usage Cost

> VS Code status-bar indicator for Claude rate-limit usage **and** equivalent API cost, computed from local Claude Code usage logs.
>
> Requires the [Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) extension (or the `claude` CLI) installed and signed in.

## At a glance

```
S：82% · 1h 12m W：31% · 4d 7h · $12.34
│   │    └ time to reset     │    └ today's equivalent API cost
│   └ utilization %          └ weekly (7d) segment
└ session (5h) segment
```

- **Rate-limit usage** is read from Anthropic's `/api/oauth/usage` endpoint.
- **Cost** is computed locally from `~/.claude/projects/**/*.jsonl` usage logs using a bundled pricing table. No billing API is ever called.
- Click the status bar once to force-refresh; double-click to open the **Weekly Cost** panel.

## Features

### Status bar
- Three display modes: `session` (5-hour window), `weekly` (7-day window), or `both`. Switch cyclically via `Claude Usage: Switch Display Mode`, or pick one directly via `Claude Usage: Set Display Mode…`.
- Configurable warning / error color thresholds (defaults: 80% yellow, 95% red).
- Appended cost segment (`· $12.34`) shows today's equivalent API cost in local timezone. Turn it off with `claudeUsageCost.cost.display: "off"`.

### Automatic rate-limit polling
- Background polling every `refreshIntervalSeconds` (default 60s, min 30s) plus proportional jitter (≤20% of the interval, capped at 60s).
- **Probe-and-fetch**: passively observes outgoing `undici` HTTP traffic via Node `diagnostics_channel`. When Claude Code itself hits `/api/oauth/usage`, this extension triggers its own refresh so the bar stays in sync without extra polling pressure.
- `Retry-After` header is honored on 429; exponential backoff on 5xx.
- Credentials are discovered in order: macOS Keychain (`Claude Code-credentials`) → `~/.claude.json` → `~/.claude/.credentials.json`. `~/.claude.json` is also watched via `fs.watch` so token rotations are picked up immediately.

### Local cost tracking
- Scans `.jsonl` files under the Claude Code log roots (`$CLAUDE_CONFIG_DIR/projects/`, `~/.claude/projects/`, `~/.config/claude/projects/`) incrementally, maintaining per-file cursors in `globalState`.
- Costs per message are computed from `input`, `output`, `cache_read`, `cache_creation_5m`, and `cache_creation_1h` token counts, using the bundled pricing table (`resources/pricing.json`).
- Model aliases (`sonnet`, `opus`, `haiku`, …) resolve to canonical IDs (e.g. `claude-sonnet-4-6`). Unknown models fall back to Opus 4.7 pricing conservatively.
- Records are attributed to the currently signed-in account (`oauthAccount.accountUuid` from `~/.claude.json`) and deduped by `messageId:requestId`.
- Multi-window safe: writes to `globalState` use optimistic locking (`{version, mtime}`) so two VS Code windows never clobber each other.

> ⚠️ **The displayed cost is *equivalent API cost*** — what you would pay if you were billed per-token via the Anthropic API. It is **not** your actual subscription charge. Pro / Team subscribers still pay their fixed monthly fee; the number here only tells you how much token value you consumed.

### Weekly Cost panel
Open with `Claude Usage: Show Weekly Cost`, or double-click the status bar item.

- Default: last 7 local days, newest first, one row per day.
- Configurable via `claudeUsageCost.weeklyCostPanel.days`: `7`, `14`, `30`, `60`, `90`, or `all`.
- In `all` mode, days are grouped **by month** (one table per month, months newest-first) plus a Grand Total.
- Each day row expands into **per-model sub-rows** (e.g. `opus-4.7`, `sonnet-4.6`, `haiku-4.5`), sorted by cost descending.
- Token columns: Input / Output / Cache Create / Cache Read / Total — plus Cost (USD). If the log entry lacks a token breakdown, `—` is shown for the per-category columns while cost is still computed from the aggregate.
- The panel reads directly from `.jsonl` without touching the incremental-cursor state used by the status bar, so opening it never interferes with today's live counter.

### Optional remote pricing updates
- Set `claudeUsageCost.cost.pricing.remoteUrl` to an HTTPS URL that returns a pricing JSON of the same shape as the bundled table; it will be fetched every 24 h and cached locally.
- Disabled by default. Query strings are stripped before any URL appears in the output channel.

## Settings

| Key | Default | Notes |
|-----|---------|-------|
| `claudeUsageCost.displayMode` | `session` | `session` / `weekly` / `both` |
| `claudeUsageCost.refreshIntervalSeconds` | `60` | min `30` |
| `claudeUsageCost.cost.display` | `today` | `today` / `off` |
| `claudeUsageCost.cost.localRefreshSeconds` | `10` | range `5`–`60`; controls how often `.jsonl` is re-scanned |
| `claudeUsageCost.cost.pricing.remoteUrl` | `""` | optional HTTPS URL for pricing updates |
| `claudeUsageCost.weeklyCostPanel.days` | `"7"` | `"7"` / `"14"` / `"30"` / `"60"` / `"90"` / `"all"` |
| `claudeUsageCost.thresholds.warning` | `80` | status-bar turns yellow at/above this % |
| `claudeUsageCost.thresholds.error` | `95` | status-bar turns red at/above this % |

All settings take effect immediately (no reload needed).

## Commands

| Command | Title |
|---------|-------|
| `claude-usage-cost.refresh` | Claude Usage: Refresh Rate Limit |
| `claude-usage-cost.switchDisplayMode` | Claude Usage: Switch Display Mode (Session / Weekly / Both) |
| `claude-usage-cost.setDisplayMode` | Claude Usage: Set Display Mode… |
| `claude-usage-cost.showWeeklyCostPanel` | Claude Usage: Show Weekly Cost |
| `claude-usage-cost.showLogs` | Claude Usage: Show Logs |

Single-click on the status-bar item triggers **Refresh**; double-click (within ~350 ms) opens the **Weekly Cost** panel.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|:-----:|:-----:|:-------:|
| Keychain-based credentials bootstrap | ✅ (`security` CLI) | ⛔ | ⛔ |
| `~/.claude.json` credential discovery | ✅ | ✅ | ✅ |
| Rate-limit polling | ✅ | ✅ | ✅ |
| Local `.jsonl` cost computation | ✅ | ✅ | ✅ |

## Requirements

- VS Code `^1.85.0`
- Node.js `>=18` (only for building from source)
- An active Claude Code sign-in whose `oauthAccount` is present in `~/.claude.json`.

## Build & install

```bash
npm install
npm run lint      # ESLint
npm run compile   # tsc (type-check only)
npm test          # vitest, 259 tests
npm run package   # produces claude-usage-cost-<version>.vsix
code --install-extension claude-usage-cost-*.vsix
```

## Privacy & network

- The only outbound HTTPS request made by default is `GET https://api.anthropic.com/api/oauth/usage` for rate-limit data.
- `claudeUsageCost.cost.pricing.remoteUrl`, when set, adds one scheduled fetch every 24 h to that URL.
- Cost figures are computed entirely from local `.jsonl` files; Anthropic's billing API is **never** contacted.
- OAuth tokens are never written to disk by this extension and never logged (emails are masked to `u***@domain` in the output channel).

## License

MIT © 2026 someHello — see the `LICENSE` file in the repository root.
