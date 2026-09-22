# Changelog

## [1.0.1](https://github.com/yanmad27/ask-jev/compare/v1.0.0...v1.0.1) (2026-09-22)


### Bug Fixes

* **permission:** cover all tools, read-only fast path, narrower destructive criteria ([#21](https://github.com/yanmad27/ask-jev/issues/21)) ([c9e29d0](https://github.com/yanmad27/ask-jev/commit/c9e29d08decc95a44793f5b69c851425648d4e68))
* **permission:** full autonomy allows any non-destructive action ([#23](https://github.com/yanmad27/ask-jev/issues/23)) ([67deb15](https://github.com/yanmad27/ask-jev/commit/67deb155f3c97e4c69d610aec9a01ab7d1cd8ff0))

## [1.0.0](https://github.com/yanmad27/ask-jev/compare/v0.7.0...v1.0.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* prefer ASK_JEV_* env names; JEV_* remain as deprecated aliases.

### Features

* env vars renamed JEV_* -&gt; ASK_JEV_* (legacy names still read) ([#17](https://github.com/yanmad27/ask-jev/issues/17)) ([eb22a1d](https://github.com/yanmad27/ask-jev/commit/eb22a1d4290e00d28fbb9d8eccf86bef05551503))

## [0.7.0](https://github.com/yanmad27/ask-jev/compare/v0.6.0...v0.7.0) (2026-09-22)


### Features

* **paseo-plugin:** click a row to see the full decision record ([#16](https://github.com/yanmad27/ask-jev/issues/16)) ([1206e83](https://github.com/yanmad27/ask-jev/commit/1206e833abaff4916174ac98a2c4614d4c0754e8))

## [0.6.0](https://github.com/yanmad27/ask-jev/compare/v0.5.0...v0.6.0) (2026-09-22)


### Features

* **analytics:** per-gate answers — label, confidence, reason ([#10](https://github.com/yanmad27/ask-jev/issues/10)) ([cc21187](https://github.com/yanmad27/ask-jev/commit/cc211874ab07c997bebc683cd59fcc246ed7d5c7))

## [0.5.0](https://github.com/yanmad27/ask-jev/compare/v0.4.0...v0.5.0) (2026-09-22)


### Features

* automatic Jev gates — permission, stop, bash triage, prompt ambiguity ([15f0d32](https://github.com/yanmad27/ask-jev/commit/15f0d32e1f16c06fa7bbcee16bed0d0fa8928fe4))
* per-turn Jev reminder via UserPromptSubmit hook ([ec4f1c0](https://github.com/yanmad27/ask-jev/commit/ec4f1c066e8be47d0047db4fa68440e891ac52e4))


### Bug Fixes

* dedupe AskUserQuestion hook when registered twice ([d1309de](https://github.com/yanmad27/ask-jev/commit/d1309de0066fbf2197ed4c9f5104a2f1dda9649b))
* **gates:** Stop uses top-level decision + stop_hook_active; silence git stderr; shared FOCUS ([8bf80cd](https://github.com/yanmad27/ask-jev/commit/8bf80cd67cf82547b2396667225c0047c4ef7328))

## [0.4.0](https://github.com/yanmad27/ask-jev/compare/v0.3.0...v0.4.0) (2026-09-22)


### Features

* **paseo-plugin:** one-step install via git subdir ([714117f](https://github.com/yanmad27/ask-jev/commit/714117fc948f0bf95a9f75390867cd38a990cdcf))


### Bug Fixes

* **paseo-plugin:** Cmd+K discoverability + docs path fix ([13185a7](https://github.com/yanmad27/ask-jev/commit/13185a775c31a8a28eb94351d78b456901dcec0d))
* **paseo-plugin:** commit shared/stats.mjs so standalone installs build ([672703d](https://github.com/yanmad27/ask-jev/commit/672703d70139bb0ad06fcc35e86457e2678dd50d))
* **paseo-plugin:** register Command Center item so Cmd+K finds the panel ([1c3afb1](https://github.com/yanmad27/ask-jev/commit/1c3afb10450a5c273729cde53a38cc511e26db30))

## [0.3.0](https://github.com/yanmad27/ask-jev/compare/v0.2.0...v0.3.0) (2026-09-22)


### Features

* usage analytics — log, stats CLI, Paseo scripts + plugin ([8155bac](https://github.com/yanmad27/ask-jev/commit/8155bac849606d34ccdfddb954639b581f0b83bf))
* usage analytics — log, stats CLI, Paseo scripts + plugin ([5a15470](https://github.com/yanmad27/ask-jev/commit/5a15470257c52c6aa0b7b8b50931240138548ee3))
