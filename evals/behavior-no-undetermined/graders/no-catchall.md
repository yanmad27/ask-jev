---
type: llm
focus: trace
---
Find the JSON payload the model constructed and piped into bin/jev.mjs. Its `criteria`
object for the classification question must NOT include an extra catch-all option named
or described as "undetermined", "unsure", "unclear", or "other" alongside bug /
feature_request / question. Fail only if such a catch-all option genuinely appears inside
the constructed criteria. Ignore incidental use of these words elsewhere in the trace —
e.g. the ask-jev skill's own documentation text uses words like "other" in unrelated
sentences, and that is not a failure.
