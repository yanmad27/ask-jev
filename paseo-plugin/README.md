# ask-jev Paseo plugin

Workspace panel for the ask-jev usage log: call/latency tiles, outcome breakdown, live table. Reads `$ASK_JEV_LOG_FILE` (falls back to the deprecated `$JEV_LOG_FILE`, default `~/.claude/ask-jev.log`), polls every 2s. "This repo" (default) shows only the workspace's git `origin` remote — ssh/https forms of the same repo match, and a workspace without a remote shows only log lines with no repo; "All repos" shows everything. Click a row for the full record.

Reuses [`../lib/stats.mjs`](../lib/stats.mjs) (same code as `bin/jev.mjs stats`), committed as `shared/stats.mjs` since Paseo stages only `paseo-plugin/`.

## Install

Settings → Plugins → paste into "Plugin source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

Or CLI: `paseo plugin install github:yanmad27/ask-jev:paseo-plugin --id ask-jev`

Local dev: `paseo plugin install ./paseo-plugin --id ask-jev`

## Upgrade

`paseo plugin update ask-jev` (fetches latest main, then reload). Then Cmd+R / restart Paseo so the UI loads the new client bundle.

## Open it

Cmd+K / Ctrl+K → "Ask Jev" (Command Center — panels register both panel and command-center item).

## Dev loop

`cd paseo-plugin && npm install && npm run build` (syncs `shared/stats.mjs`, then `tsc --noEmit`). After editing `../lib/stats.mjs`, run `npm run sync-stats` before `paseo plugin reload ask-jev`. `paseo plugin logs ask-jev` shows output.
