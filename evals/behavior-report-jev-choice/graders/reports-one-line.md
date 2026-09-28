---
type: llm
focus: last_message
---
The response must explicitly report Jev's decision to the user as one clear line in the
form `Jev chose "bug" (0.93)` — the option name and its confidence, not buried in a
paragraph or omitted while the model just proceeds to file the ticket. Fail if the
response never states the choice and confidence together, or silently acts on the
classification without telling the user what Jev decided.
