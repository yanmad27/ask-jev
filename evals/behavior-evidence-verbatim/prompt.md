---
description: The state Jev receives must be the evidence verbatim, not a paraphrase.
tags: [behavior]
allowed_tools: [Skill, Bash]
expected_outcome: the constructed request pastes the ticket text verbatim into `state`
---

A user just filed this support ticket:

"After the 2.3.0 update, tapping 'Export CSV' on the Reports tab does nothing — no
download, no error toast, just silence. This started right after we upgraded to 2.3.0
yesterday."

Use the ask-jev skill to classify it as bug, feature_request, or question.
