import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasContext, readUserPastChoices } from "../lib/context.mjs";

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
  const { stdout } = await execFileAsync("node", ["-e", script], { env: { ...cleanEnv(), HOME: home, ...extraEnv }, encoding: "utf8" });
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

test("buildState: transcriptRows accepts conversation rows directly (no transcriptPath needed), same filtering as the file path", async () => {
  const home = tmpHome();
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd-rows-"));
  const rows = [
    { type: "user", message: { content: "hello from rows" } },
    { type: "user", isSidechain: true, message: { content: "should be filtered (sidechain)" } },
    { type: "assistant", message: { content: "hi" } },
  ];
  const { state } = await callBuildState({ transcriptRows: rows, cwd }, home);
  assert.equal(state.task.current_task, "hello from rows");
  assert.ok(!state.conversation.turns.some((t) => t.includes("should be filtered")));
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
  const child = execFileAsync("node", [script], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_LOG_FILE: logFile }, encoding: "utf8" });
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

  const all = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "outcome");
  const events = all.filter((e) => e.kind_of_answer !== "unparsed");
  assert.equal(events.length, 2, "only the two real answer strings produce parsed outcome events");
  assert.equal(all.length - events.length, 3, "everything else is logged as unparsed, never dropped");

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

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const human = (text) => ({ type: "user", message: { content: text } });
const toolResult = (text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

async function stateFor(rows, extraEnv = {}) {
  const home = tmpHome();
  const cwd = mkdtempSync(join(tmpdir(), "ctx-cwd-h-"));
  const transcript = join(cwd, "t.jsonl");
  writeFileSync(transcript, jsonl(rows));
  return callBuildState({ transcriptPath: transcript, cwd }, home, extraEnv);
}

test("buildState: user messages are human-typed text only — tool_result user rows are excluded, mixed rows keep just their text parts", async () => {
  const { state } = await stateFor([
    human("please use pnpm"),
    assistant("running"),
    toolResult("TOOL-OUTPUT-SENTINEL npm install ok"),
    { type: "user", message: { content: [{ type: "tool_result", content: "MIXED-TOOL-SENTINEL" }, { type: "text", text: "and keep tabs" }] } },
    toolResult("LAST-TOOL-SENTINEL"),
  ]);
  assert.deepEqual(state.task.recent_user_messages, ["please use pnpm", "and keep tabs"]);
  assert.equal(state.task.current_task, "and keep tabs");
  assert.doesNotMatch(JSON.stringify(state.task), /SENTINEL/);
});

test("buildState: only tool_result user rows → no human message, current_task empty", async () => {
  const { state } = await stateFor([toolResult("x"), toolResult("y")]);
  assert.deepEqual(state.task.recent_user_messages, []);
  assert.equal(state.task.current_task, "");
});

test("buildState: human messages are verbatim, each capped, total bounded", async () => {
  const exact = "line one\n  indented \"quoted\" — verbatim ✓";
  const big = "B".repeat(10_000);
  const { state } = await stateFor([human(exact), human(big), human("tail")]);
  assert.equal(state.task.recent_user_messages[0], exact);
  assert.ok(state.task.recent_user_messages[1].length <= 3_000);
  assert.ok(state.task.recent_user_messages[1].startsWith("BBBB"));
  assert.ok(state.task.recent_user_messages[1].endsWith("…[truncated]"));
  assert.ok(state.task.recent_user_messages.join("").length <= 5 * 3_000);
  assert.equal(state.task.current_task, "tail");
});

test("buildState: latest user message > 70k chars still yields context, capped verbatim head, older turns kept, state under the cap", async () => {
  const huge = "HEAD-OF-REQUEST " + "z".repeat(120_000);
  const { state } = await stateFor([human("first ask"), assistant("ok first"), human("second ask"), assistant("ok second"), human(huge)]);
  assert.equal(hasContext(state), true);
  assert.ok(state.task.current_task.startsWith("HEAD-OF-REQUEST zzz"));
  assert.ok(state.task.current_task.length <= 3_000);
  assert.ok(JSON.stringify(state).length <= 70_000, `state ${JSON.stringify(state).length}`);
  const turns = state.conversation.turns.join("\n");
  assert.match(turns, /User: first ask/);
  assert.match(turns, /Claude: ok second/);
  assert.ok(state.conversation.turns.every((t) => t.length <= 4_000));
});

test("buildState: state size stays under the unchanged 70k cap with oversized everything, and ASK_JEV_STATE_CHARS still lowers it", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => [human(`q${i} ` + "w".repeat(6_000)), assistant("a".repeat(6_000))]).flat();
  const { state, sizes } = await stateFor(rows);
  assert.ok(JSON.stringify(state).length <= 70_000);
  assert.ok(sizes.conversation > 0);
  const small = await stateFor(rows, { ASK_JEV_STATE_CHARS: "20000" });
  assert.ok(JSON.stringify(small.state).length <= 20_000);
});

test("readUserPastChoices: reads schema-v2 outcome rows (with Jev's recommendation) and legacy user_choice rows, same cwd first", () => {
  const log = join(mkdtempSync(join(tmpdir(), "ctx-log-")), "jev.log");
  writeFileSync(log, jsonl([
    { kind: "user_choice", cwd: "/other", question: "legacy q", chosen: ["X"], kind_of_answer: "option" },
    { schema: 2, kind: "outcome", cwd: "/here", question: "new q", chosen: ["B"], kind_of_answer: "option", recommended: ["A"], recommended_confidence: 0.9, agreement: "disagree" },
    { schema: 2, kind: "outcome", cwd: "/here", question: "typed q", chosen: ["my own"], kind_of_answer: "free_text", recommended: null, agreement: "no_advice" },
    { kind: "decision", gate: "ask", question: "not a choice" },
  ]));
  const saved = process.env.ASK_JEV_LOG_FILE;
  process.env.ASK_JEV_LOG_FILE = log;
  try {
    const { choices } = readUserPastChoices("/here");
    assert.deepEqual(choices.map((c) => c.question), ["typed q", "new q", "legacy q"]);
    assert.deepEqual(choices[1], { question: "new q", chosen: ["B"], kind_of_answer: "option", jev_recommended: ["A"], agreement: "disagree" });
    assert.deepEqual(choices[2], { question: "legacy q", chosen: ["X"], kind_of_answer: "option" });
    assert.ok(!("jev_recommended" in choices[0]));
  } finally {
    saved === undefined ? delete process.env.ASK_JEV_LOG_FILE : (process.env.ASK_JEV_LOG_FILE = saved);
  }
});

test("buildState: a huge transcript is read from its tail only — recent rows kept, bounded time", async () => {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "ctx-big-"));
  const path = join(dir, "t.jsonl");
  const filler = JSON.stringify({ type: "user", message: { content: `filler ${"x".repeat(900)}` } }) + "\n";
  const chunk = filler.repeat(1000);
  const fd = openSync(path, "w");
  writeSync(fd, JSON.stringify({ type: "user", message: { content: "VERY-FIRST-MESSAGE" } }) + "\n");
  for (let i = 0; i < 100; i++) writeSync(fd, chunk); // ≈ 90 MB
  writeSync(fd, JSON.stringify({ type: "user", message: { content: "the newest human request" } }) + "\n");
  writeSync(fd, '{"type":"assistant","message":{"content":"partial line, no newline');
  closeSync(fd);
  const t0 = Date.now();
  const state = await callBuildState({ transcriptPath: path, cwd: dir, sessionId: "big" }, home);
  const elapsed = Date.now() - t0;
  const text = JSON.stringify(state);
  assert.match(text, /the newest human request/);
  assert.doesNotMatch(text, /VERY-FIRST-MESSAGE/);
  assert.ok(elapsed < 4000, `took ${elapsed}ms`);
});
