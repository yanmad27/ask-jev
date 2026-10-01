# ask-jev Paseo plugin

Workspace panel for the ask-jev usage log: call/latency tiles, outcome breakdown, live table. Reads `$ASK_JEV_LOG_FILE` (falls back to the deprecated `$JEV_LOG_FILE`, default `~/.claude/ask-jev.log`), polls every 2s. "This repo" (default) shows only the workspace's git `origin` remote — ssh/https forms of the same repo match, and a workspace without a remote shows only log lines with no repo; "All repos" shows everything. Click a row for the full record.

Advises on `AskUserQuestion` permission requests — it never answers them. `respondToPermission` is never called for a question: the card reaches you exactly as the agent asked it. While the question is pending, the plugin appends one timeline item per question (kind `ask-jev.advice`, v1): `Jev advice: "X" (0.86) — <the option's description>`, tagged low-confidence when under `ASK_THRESHOLD` and tagged whether it is grounded in your own messages/past choices. Paseo permission events are observe-only, so the advice is a separate item rather than text on the card (whether it sits beside the pending card is Paseo UI behaviour). When Jev fails (provider error, timeout, 402), a `Jev advice unavailable — …` item says so; a 402 additionally says Jev's credits are exhausted, once per agent session. A missing API key is silent (log row only). When you answer, an `outcome` row records your choice next to Jev's recommendation (`agree` / `disagree` / `partial` for multiSelect / `free_text` / `no_advice`), linked to the advice row by `invocation_id` (`<agent id>:<request id>`). The panel shows "Human answers" and "Agreement with Jev". A request still pending after 24h (override: `ASK_JEV_PASEO_TTL_MS`) is dropped from the in-memory map, and a `timeline.append` already started when you answer can still land afterwards (it cannot be cancelled; the outcome row already records `no_advice`), and unloading the plugin drops in-flight advice and any outcome for questions still pending. Claude Code's own `AskUserQuestion` hook still stands down under `PASEO_AGENT_ID` (logged as `standdown`), so the two never double-advise.

Needs the same Jev API key as the hooks — `~/.claude/ask-jev.key`, or `TYPESAFE_API_KEY`/`ASK_JEV_API_KEY` — but it's read from the **Paseo daemon's** own environment and home directory, not the shell you happen to be typing in. If you only export the key in a shell rc, the daemon may never see it; the key file sidesteps that.

Install only **one** copy of the plugin. Two copies loaded in the same process (e.g. `ask-jev` and a local dev copy `ask-jev-dev`) share an in-memory dedupe map keyed by agent + request id, so they won't both answer the same request — but there's no reason to run two.

Reuses [`../lib/`](../lib/) (same policy as the hooks), committed verbatim since Paseo stages only `paseo-plugin/` — but not all into `shared/`: Paseo bundles a plugin's `shared/` as one isomorphic (client+server) chunk and refuses any Node built-in import there, so only the Node-free `stats.mjs` lives in `shared/`; the rest (`jev`/`context`/`gate`/`env`/`answer-policy.mjs`, all server-only) live under `server/vendor/` instead. `server/shared-no-node-builtins.test.ts` guards `shared/` against a regression.

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

`cd paseo-plugin && npm install && npm run build` (syncs `shared/` and `server/vendor/`, then `tsc --noEmit`). After editing anything in `../lib/`, run `npm run sync-shared` before `paseo plugin reload ask-jev` — CI fails if either copy drifts from `../lib/` (`../scripts/sync-paseo-shared.sh --check`). `npm test` runs the plugin's own tests (`node --test` via `tsx`). `paseo plugin logs ask-jev` shows output.
