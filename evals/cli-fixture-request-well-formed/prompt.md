---
description: A valid fixture request produces either a parsed answer or a single clear "no API key" line — never a crash.
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'either JSON with a choice/probability field, or a single "jev: no API key" line — never a stack trace'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its exit code and full
stdout/stderr verbatim:

```
cat > fixture.json <<'JSON'
{
  "state": { "ticket": "App bị crash mỗi khi tôi mở màn hình cài đặt sau khi cập nhật lên bản mới nhất." },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": { "question": "Which category does `ticket` belong to?", "focus": "Classify what's reported, not how urgent it sounds." },
      "criteria": {
        "bug": { "what": "A defect in existing behavior — something that used to work and now doesn't", "not_for": "feature_request, question", "examples": ["app crashes on launch"] },
        "feature_request": { "what": "A request for new behavior that never existed", "not_for": "bug, question", "examples": ["please add dark mode"] },
        "question": { "what": "The customer wants to understand something, no defect implied", "not_for": "bug, feature_request", "examples": ["how do I export my data"] }
      }
    }
  }
}
JSON
node <jev.mjs> fixture.json; echo "EXIT:$?"
```
