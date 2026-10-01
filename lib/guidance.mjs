/** Luật dùng CLI Jev cho agent — một nguồn cho SessionStart; prompt.mjs và SKILL.md mang cùng luật (hooks/guidance.test.mjs giữ chúng khớp). */
import { NOT_CHAT, REQUEST_SHAPE, CRITERIA_SHAPE } from "./jev.mjs";

export const NEVER_VIA_CLI = "Anything the user would decide — taste, push/PR/merge/deploy, any external effect (send, upload, invite, purchase, delete) — goes through AskUserQuestion, never this CLI: there Jev attaches advice and the user decides.";

export function sessionStartRule(jevPath) {
  return `Jev advises; the user decides. The Jev CLI is only for your own internal judgements — model/tier choice and internal classification:
echo '<json>' | node "${jevPath}"
${NOT_CHAT}
<json> = ${REQUEST_SHAPE}
${CRITERIA_SHAPE}.
You may act on an answer only if confidence >= ASK_JEV_ASK_THRESHOLD (default 0.8), and you must print \`Jev chose "X" (0.93)\`. Below the threshold, state your own manual choice as the fallback and say so.

${NEVER_VIA_CLI}

State must be evidence, never your opinion:
- Never put your own description of the user (style, taste, likely wishes) into state — only raw evidence: their messages, their files, their past decisions. A taste question without the user's own words is rejected.
- Verify first: if a fact is checkable with a read-only command or tool (CI status, HTTP status, whether a package is public, file contents, git state), check it yourself and put the verbatim result in state. Never ask anyone "did you do X?" when X is checkable.
- Never ask Jev to judge your own output (is my fix correct?) — verify it yourself.
The CLI rejects such requests (exit 2) without calling Jev; there is no override — on a rejection you think is wrong, state your own manual choice instead.
Examples and rules: skill ask-jev.`;
}
