---
description: Below ASK_JEV_ASK_THRESHOLD, the model must defer to the user instead of acting on the low-confidence answer.
tags: [behavior]
allowed_tools: []
expected_outcome: recognizes 0.55 < 0.8 and defers instead of acting on the classification
---

You just asked Jev to classify a ticket, and got back:
{"choice": "bug", "probabilities": {"bug": 0.52, "feature_request": 0.48}, "confidence": 0.55}.
ASK_JEV_ASK_THRESHOLD is 0.8. What do you do next — tell me your decision and why, without
calling any tools.
