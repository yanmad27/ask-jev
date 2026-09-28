# ask-jev Paseo plugin

Workspace panel for the ask-jev usage log: call/latency tiles, outcome breakdown, live table. Reads `$ASK_JEV_LOG_FILE` (falls back to the deprecated `$JEV_LOG_FILE`, default `~/.claude/ask-jev.log`), polls every 2s. "This repo" (default) shows only the workspace's git `origin` remote — ssh/https forms of the same repo match, and a workspace without a remote shows only log lines with no repo; "All repos" shows everything. Click a row for the full record.

Also answers `AskUserQuestion` permission requests with Jev directly, via `respondToPermission` — no hook, no red `hook error`. A request is all-or-nothing: if Jev defers even one of its questions (personal and ungrounded, destructive, no key, no context, an option missing a definition, ...), the whole request reaches you unanswered rather than a partial answer. Every answer is reported in the agent's timeline as `Jev chose "X" (0.93)`. Claude Code's own `AskUserQuestion` hook still stands down under `PASEO_AGENT_ID` regardless (logged as a `kind:"diagnostic"` event, not a `decision`), so it never fights with this plugin over the same question.

Needs the same Jev API key as the hooks — `~/.claude/ask-jev.key`, or `TYPESAFE_API_KEY`/`ASK_JEV_API_KEY` — but it's read from the **Paseo daemon's** own environment and home directory, not the shell you happen to be typing in. If you only export the key in a shell rc, the daemon may never see it; the key file sidesteps that.

Install only **one** copy of the plugin. Two copies loaded in the same process (e.g. `ask-jev` and a local dev copy `ask-jev-dev`) share an in-memory dedupe map keyed by agent + request id, so they won't both answer the same request — but there's no reason to run two.

Reuses [`../lib/`](../lib/) (same policy as the hooks) — the whole directory is committed verbatim as `shared/` since Paseo stages only `paseo-plugin/`.

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

`cd paseo-plugin && npm install && npm run build` (syncs `shared/`, then `tsc --noEmit`). After editing anything in `../lib/`, run `npm run sync-shared` before `paseo plugin reload ask-jev` — CI fails if `shared/` drifts from `../lib/` (`../scripts/sync-paseo-shared.sh --check`). `npm test` runs the plugin's own tests (`node --test` via `tsx`). `paseo plugin logs ask-jev` shows output.
