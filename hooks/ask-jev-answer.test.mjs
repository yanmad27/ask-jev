import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

async function runAnswerHook(toolResponse, logFile) {
  const script = join(repoRoot, "hooks", "ask-jev-answer.mjs");
  const input = { tool_name: "AskUserQuestion", session_id: "sess-1", cwd: "/repo", tool_response: toolResponse };
  const child = execFileAsync("node", [script], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_LOG_FILE: logFile }, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify(input));
  await child;
}

function userChoices(logFile) {
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "user_choice");
}

function tmpLog() {
  return join(mkdtempSync(join(tmpdir(), "answer-hook-log-")), "jev.log");
}

test("ask-jev-answer.mjs: tool_response.content as a content-block array (text parts) is parsed like a string", async () => {
  const logFile = tmpLog();
  const toolResponse = { content: [{ type: "text", text: 'Your questions have been answered: "Pick a color"="Blue". You can now continue with these answers in mind.' }] };
  await runAnswerHook(toolResponse, logFile);

  const events = userChoices(logFile);
  assert.equal(events.length, 1);
  assert.equal(events[0].question, "Pick a color");
  assert.deepEqual(events[0].chosen, ["Blue"]);
  assert.equal(events[0].kind_of_answer, "option");
});

test("ask-jev-answer.mjs: multiple text parts in the content array are concatenated before matching", async () => {
  const logFile = tmpLog();
  const toolResponse = {
    content: [
      { type: "text", text: 'The user answered: "Where is it?"=' },
      { type: "text", text: '"~/Downloads/logo.png". Read the answers carefully.' },
    ],
  };
  await runAnswerHook(toolResponse, logFile);

  const events = userChoices(logFile);
  assert.equal(events.length, 1);
  assert.equal(events[0].question, "Where is it?");
  assert.deepEqual(events[0].chosen, ["~/Downloads/logo.png"]);
  assert.equal(events[0].kind_of_answer, "free_text");
});

test("ask-jev-answer.mjs: object with a plain string content still works (existing shape)", async () => {
  const logFile = tmpLog();
  const toolResponse = { content: 'Your questions have been answered: "Stack?"="Node". You can now continue with these answers in mind.' };
  await runAnswerHook(toolResponse, logFile);

  const events = userChoices(logFile);
  assert.equal(events.length, 1);
  assert.equal(events[0].question, "Stack?");
  assert.deepEqual(events[0].chosen, ["Node"]);
});

test("ask-jev-answer.mjs: non-matching or malformed content arrays never log and never throw", async () => {
  const logFile = tmpLog();
  await runAnswerHook({ content: [{ type: "text", text: "Tool permission request failed: canceled" }] }, logFile);
  await runAnswerHook({ content: [{ type: "image", source: {} }] }, logFile);
  await runAnswerHook({ content: 123 }, logFile);
  await runAnswerHook({}, logFile);

  let raw = "";
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    // no log file at all is also a pass — nothing matched
  }
  const events = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "user_choice");
  assert.equal(events.length, 0);
});
