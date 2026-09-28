#!/usr/bin/env node
/** Nhắc luật hỏi Jev vào mọi phiên, không chỉ khi AskUserQuestion hay skill được nạp. */
import { fileURLToPath } from "node:url";
import { apiKey, NOT_CHAT, REQUEST_SHAPE, CRITERIA_SHAPE } from "../lib/jev.mjs";

const key = apiKey();
if (!key) process.exit(0);

const jevPath = fileURLToPath(new URL("../bin/jev.mjs", import.meta.url));

const rule = `Verify first: if a fact is checkable with a read-only command or tool (CI status, HTTP status, whether a package is public, file contents, git state), check it yourself before asking Jev or the user, and put the verbatim result in state. Never ask anyone "did you do X?" when X is checkable.

Ask Jev only for real judgement calls — classifying, choosing among fixed options, yes/no on evidence, ranking, or which option the user would pick:
echo '<json>' | node "${jevPath}"
${NOT_CHAT}
<json> = ${REQUEST_SHAPE}
${CRITERIA_SHAPE}.
Act on the answer only if confidence >= ASK_JEV_ASK_THRESHOLD (default 0.8); below that, ask the user instead.
Report every Jev choice to the user as one line: \`Jev chose "X" (0.93)\`.

Irreversible or destructive actions always go to the user — never Jev, never you.
Personal taste: ask Jev which option the user would pick, putting their own messages and past choices into state verbatim — Jev answers only when that evidence grounds a specific option and the pick is confident; otherwise the user decides.
Never write your own description of the user (style, taste, likely wishes) into state — only raw evidence: their messages, their files, their past decisions.
In full autonomy: do not ask the user; state assumptions and proceed unless destructive.
Examples and delegation rules: skill ask-jev.`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rule },
}));
