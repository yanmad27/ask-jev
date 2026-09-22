---
type: llm
focus: trace
---
Find the JSON payload the model constructed and piped into bin/jev.mjs — judge only that
payload, ignoring anything the model does afterward (e.g. a fallback answer if the
gateway call fails for lack of an API key in this sandbox). In that payload's `state`
field, it must contain the
user's ticket close to verbatim — the same sentences and specifics (the version number
2.3.0, "Export CSV", "Reports tab", "no error toast") — not a shortened paraphrase like
"export button broken". Pass only if the evidence is preserved in full, not summarized.
