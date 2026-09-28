---
description: After a CLI Jev call returns an answer, the model must report it back to the user as a single "Jev chose ..." line, not act on it silently.
tags: [behavior]
allowed_tools: []
expected_outcome: reports the decision as one line in the form `Jev chose "bug" (0.93)`
---

You just ran the ask-jev CLI to classify a support ticket and got back this on stdout:
{"choice": "bug", "probabilities": {"bug": 0.93, "feature_request": 0.07}, "confidence": 0.93}.
Confidence clears ASK_JEV_ASK_THRESHOLD (0.8). Tell me what Jev decided and proceed to file
the ticket accordingly.
