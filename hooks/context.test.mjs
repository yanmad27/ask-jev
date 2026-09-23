import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), "ctx-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

async function callBuildState(opts, home, extraEnv = {}) {
  const modulePath = join(repoRoot, "lib", "context.mjs").replace(/\\/g, "/");
  const script = `import("${modulePath}").then(({buildState}) => { process.stdout.write(JSON.stringify(buildState(${JSON.stringify(opts)}))); });`;
  const { stdout } = await execFileAsync("node", ["-e", script], { env: { ...process.env, HOME: home, ...extraEnv }, encoding: "utf8" });
  return JSON.parse(stdout);
}

test("buildState: preferences read verbatim from a fixture CLAUDE.md in temp HOME, capped", async () => {
  const home = tmpHome();
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "Always use tabs, never spaces.\n");
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd-"));
  const transcript = join(cwd, "t.jsonl");
  writeFileSync(transcript, "");
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home);
  assert.match(state.preferences.content, /Always use tabs/);
  assert.ok(state.preferences.content.length <= 8_000);
});

test("buildState: recent_user_messages keeps only the last 5, current_task is the latest", async () => {
  const home = tmpHome();
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd2-"));
  const transcript = join(cwd, "t.jsonl");
  const rows = Array.from({ length: 7 }, (_, i) => JSON.stringify({ type: "user", message: { content: `msg ${i + 1}` } }));
  writeFileSync(transcript, rows.join("\n") + "\n");
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home);
  assert.deepEqual(state.task.recent_user_messages, ["msg 3", "msg 4", "msg 5", "msg 6", "msg 7"]);
  assert.equal(state.task.current_task, "msg 7");
});

test("buildState: compaction summary excluded from task/conversation, TodoWrite captured", async () => {
  const home = tmpHome();
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd3-"));
  const transcript = join(cwd, "t.jsonl");
  const rows = [
    JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "Summary: did X and Y." } }),
    JSON.stringify({ type: "user", message: { content: "now do Z" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "do Z", status: "pending" }] } }] } }),
  ];
  writeFileSync(transcript, rows.join("\n") + "\n");
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home);
  assert.equal(state.session_summary.text, "Summary: did X and Y.");
  assert.deepEqual(state.plan_and_todos.todos, [{ content: "do Z", status: "pending" }]);
  assert.equal(state.task.current_task, "now do Z");
});

test("buildState: settings.json allow rules surface as permissions.allow", async () => {
  const home = tmpHome();
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd4-"));
  const transcript = join(cwd, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home);
  assert.ok(state.permissions.allow.includes("Bash(npm test)"));
});

test("buildState: user_past_choices puts same-cwd entries first", async () => {
  const home = tmpHome();
  const logFile = join(mkdtempSync(join(tmpdir(), "ctx-log-")), "jev.log");
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd5-"));
  const lines = [
    JSON.stringify({ kind: "user_choice", cwd: "/some/other/repo", question: "Q-other", options: ["a", "b"], chosen: ["a"] }),
    JSON.stringify({ kind: "user_choice", cwd, question: "Q-same", options: ["a", "b"], chosen: ["b"] }),
  ];
  writeFileSync(logFile, `${lines.join("\n")}\n`);
  const transcript = join(cwd, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home, { ASK_JEV_LOG_FILE: logFile });
  assert.equal(state.user_past_choices.choices[0].question, "Q-same");
});

async function runAnswerHook(toolResponse, logFile) {
  const script = join(repoRoot, "hooks", "ask-jev-answer.mjs");
  const input = { tool_name: "AskUserQuestion", session_id: "sess-1", cwd: "/repo", tool_response: toolResponse };
  const child = execFileAsync("node", [script], { env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_LOG_FILE: logFile }, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify(input));
  await child;
}

test("ask-jev-answer.mjs: parses real AskUserQuestion tool_response strings, ignores everything else", async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "ctx-answer-log-")), "jev.log");
  const positive1 = 'Your questions have been answered: "Enforce \\"definition bắt buộc\\" ở đâu?"="Hook enforce + README (Recommended)". You can now continue with these answers in mind.';
  const positive2 = 'The user answered: "Where is the logo file on disk? (...)"="~/Downloads/....jpg". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
  const negativeOwnDeny = 'Not a real error — Jev already answered this for you from the conversation, so you don\'t have to ask. Use these choices and continue; do not re-ask:\n"Which option?" → A (Jev: 0.91)';
  const negativeCanceled = "Tool permission request failed: ... canceled";
  // "Answer: ..." is an ORCHESTRATOR deny reason (another agent denying the
  // AskUserQuestion permission with a message) — not a real user answer. Confirmed by
  // security review; do not reopen this exclusion without re-checking that.
  const negativeAnswerProse = "Answer: the user wants to proceed with option B, do not ask again";

  for (const s of [positive1, positive2, negativeOwnDeny, negativeCanceled, negativeAnswerProse]) {
    await runAnswerHook(s, logFile);
  }

  const events = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "user_choice");
  assert.equal(events.length, 2, "only the two real answer strings produce user_choice events");

  assert.equal(events[0].question, 'Enforce "definition bắt buộc" ở đâu?');
  assert.deepEqual(events[0].chosen, ["Hook enforce + README (Recommended)"]);
  assert.equal(events[0].kind_of_answer, "option");

  assert.equal(events[1].question, "Where is the logo file on disk? (...)");
  assert.deepEqual(events[1].chosen, ["~/Downloads/....jpg"]);
  assert.equal(events[1].kind_of_answer, "free_text");
});

test("buildState: ASK_JEV_STATE_CHARS is enforced on the real serialized state, not summed per-field estimates", async () => {
  const home = tmpHome();
  // 20k CLAUDE.md — way over a 1000-char cap; the old bug summed each field's own
  // internal cap (preferences alone up to 8000) and always included it regardless of
  // ASK_JEV_STATE_CHARS, so a small cap still let an ~8.8x-oversized state through.
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "x".repeat(20_000));
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd6-"));
  const transcript = join(cwd, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  const { state } = await callBuildState({ transcriptPath: transcript, cwd }, home, { ASK_JEV_STATE_CHARS: "1000" });
  assert.ok(JSON.stringify(state).length <= 1000, `serialized state must be <= 1000 chars, got ${JSON.stringify(state).length}`);
});
