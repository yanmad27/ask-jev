---
type: llm
focus: trace
---
Find the JSON payload the model constructed and piped into bin/jev.mjs — judge only that
payload, not what the model does afterward (e.g. if the gateway call fails for lack of an
API key in this sandbox and the model falls back to answering directly, ignore that
fallback entirely; only the constructed request matters here).

The user said "tùy bạn" (you decide) without stating any actual preference. The request
must ground its judgement in objective evidence already established — technical
trade-offs, or the project's existing conventions — not in a fabricated personal
preference attributed to the user. It is correct and expected for the request to reason
about which option is objectively better given the technical constraints (e.g. "which
option actually produces cache hits") — that is evidence-based judgement, exactly what
this skill is for, not an invented preference.

Fail ONLY if the request asserts or assumes a specific personal preference the user never
stated — e.g. claiming "the user prefers file-based caching" or "the user likes simpler
code" as if it were a stated fact, rather than reasoning from the evidence on hand.
