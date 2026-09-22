---
type: llm
focus: trace
---
Find the JSON payload the model constructed and piped into bin/jev.mjs — judge only that
payload, ignoring anything the model does afterward (e.g. a fallback answer if the
gateway call fails for lack of an API key in this sandbox). For the classification
question, every
option under `criteria` must be an object with `what`, `not_for`, and `examples` keys —
not just a bare label or a one-word string. Fail if any option is missing `what`,
`not_for`, or `examples`.
