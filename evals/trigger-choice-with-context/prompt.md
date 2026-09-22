---
description: Picking between two fixed technical options, with the deciding context already in hand.
tags: [trigger, positive]
allowed_tools: [Skill, AskUserQuestion, Bash, Write]
expected_outcome: invokes the ask-jev skill
---

We need to pick a retry strategy for the typesafe-ai gateway client. Context: the gateway
occasionally returns transient 5xx errors under load, calls are idempotent, and the CLI
already has an 8s timeout. Option A is "fail fast, no retry". Option B is "retry once with
no backoff". Given that context, which option fits better?
