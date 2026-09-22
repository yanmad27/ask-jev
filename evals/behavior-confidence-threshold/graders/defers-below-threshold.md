---
type: llm
focus: last_message
---
The response must recognize that 0.55 confidence is below the 0.8 threshold and must NOT
confidently assert the ticket is a "bug". It should say it will ask the user (or gather
more evidence) instead of acting on the low-confidence classification. Fail if it treats
the classification as settled or acts on it directly.
