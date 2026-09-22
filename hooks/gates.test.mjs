import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const transcript = join(mkdtempSync(join(tmpdir(), "gates-")), "t.jsonl");
writeFileSync(transcript, '{"type":"user","message":{"content":"please refactor the parser"}}\n{"type":"assistant","message":{"content":"ok"}}\n');
const logFile = join(mkdtempSync(join(tmpdir(), "gates-log-")), "jev.log");

function stub(answers) {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// Đếm request thật để chứng minh fast path không gọi mạng, không chỉ trả lời đúng.
function countingStub(answers) {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, count: () => count })));
}

// Mặc định "safe" — bộ test này viết cho hành vi trước autonomy; autonomy.test.mjs tự
// override "full" cho từng test cần.
async function runGateFull(name, input, url, gates = name, cwd, mode = "safe") {
  const script = fileURLToPath(new URL(`gates/${name}.mjs`, import.meta.url));
  const child = execFileAsync("node", [script], {
    cwd,
    env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ASK_JEV_GATES: gates, ASK_JEV_REMIND: "0", ASK_JEV_AUTONOMY: mode },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  return child;
}
async function runGate(name, input, url, gates = name) {
  return (await runGateFull(name, input, url, gates)).stdout;
}

function lastDecision(gate) {
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return lines.filter((e) => e.kind === "decision" && e.gate === gate).at(-1);
}
function assertDecisionShape(d) {
  assert.ok(typeof d.question === "string" && d.question.length > 0, "question populated");
  assert.ok(typeof d.label === "string" && d.label.length > 0, "label populated");
  assert.ok(typeof d.confidence === "number", "confidence populated");
  assert.ok(typeof d.reason === "string" && d.reason.length > 0, "reason populated");
}

const editInput = { tool_name: "Edit", transcript_path: transcript, cwd: process.cwd(), tool_input: { file_path: "a.js" } };
const bashInput = { tool_name: "Bash", transcript_path: transcript, cwd: process.cwd(), tool_input: { command: "npm test" }, tool_response: "1 failing\n" };
const stopInput = { session_id: `stop-${Math.random()}`, transcript_path: transcript, cwd: process.cwd(), last_assistant_message: "done" };
const promptInput = { session_id: "x", prompt: "please refactor the auth module completely", transcript_path: transcript, cwd: process.cwd() };

test("permission gate: allow on p=0.95, ask on p=0.1, ask on p=0.5 (no more silent 'unsure'); decision log has label/confidence/reason", async () => {
  for (const [p, decision] of [[0.95, "allow"], [0.1, "ask"], [0.5, "ask"]]) {
    const server = await stub({ safe: { probability: p }, destructive: { probability: 0.1 } });
    const out = await runGate("permission", editInput, `http://127.0.0.1:${server.address().port}`);
    server.close();
    assert.match(out, new RegExp(`"permissionDecision":"${decision}"`));
  }
  const d = lastDecision("permission");
  assertDecisionShape(d);
  assert.match(d.question, /^Edit /);
});

test("permission gate: destructive=0.7 always blocks allow, even with safe=0.95, both modes (security fix)", async () => {
  for (const mode of ["safe", "full"]) {
    const server = await stub({ safe: { probability: 0.95 }, destructive: { probability: 0.7 } });
    const { stdout } = await runGateFull("permission", editInput, `http://127.0.0.1:${server.address().port}`, "permission", undefined, mode);
    server.close();
    assert.doesNotMatch(stdout, /"permissionDecision":"allow"/);
    assert.match(stdout, /"permissionDecision":"ask"/);
  }
});

test("permission gate: fast path allows Read and mcp__paseo__list_workspaces with zero gateway calls", async () => {
  const { server, count } = await countingStub({ safe: { probability: 0.99 }, destructive: { probability: 0.01 } });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const toolName of ["Read", "mcp__paseo__list_workspaces"]) {
    const input = { tool_name: toolName, transcript_path: transcript, cwd: process.cwd(), tool_input: {} };
    const out = await runGate("permission", input, url);
    assert.match(out, /"permissionDecision":"allow"/);
  }
  server.close();
  assert.equal(count(), 0, "fast path must not call the gateway");
  const d = lastDecision("permission");
  assert.equal(d.outcome, "allow");
  assert.equal(d.reason, "read-only tool");
});

test("permission gate: Bash rm -rf ~/x (non-scratch path) still asks", async () => {
  const server = await stub({ safe: { probability: 0.9 }, destructive: { probability: 0.75 } });
  const input = { tool_name: "Bash", transcript_path: transcript, cwd: process.cwd(), tool_input: { command: "rm -rf ~/x" } };
  const out = await runGate("permission", input, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out, /"permissionDecision":"ask"/);
});

test("permission gate: Bash git push origin feat/x allows at safe=0.9 destructive=0.1", async () => {
  const server = await stub({ safe: { probability: 0.9 }, destructive: { probability: 0.1 } });
  const input = { tool_name: "Bash", transcript_path: transcript, cwd: process.cwd(), tool_input: { command: "git push origin feat/x" } };
  const out = await runGate("permission", input, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out, /"permissionDecision":"allow"/);
});

test("stop gate: blocks with top-level decision on p(incomplete)=0.9, skips when stop_hook_active; decision log populated", async () => {
  const server = await stub({ incomplete: { probability: 0.9 } });
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = JSON.parse(await runGate("stop", stopInput, url));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /incomplete/);
  const skipped = await runGate("stop", { ...stopInput, stop_hook_active: true }, url);
  server.close();
  assert.equal(skipped, "");

  const d = lastDecision("stop");
  assertDecisionShape(d);
  assert.equal(d.question, "done");
  assert.equal(d.label, "incomplete");
  assert.ok(d.confidence > 0.5);
});

test("bash gate: emits additionalContext for tests_failed; decision log populated", async () => {
  const server = await stub({ result: { choice: "tests_failed", probabilities: { tests_failed: 0.9 } } });
  const out = await runGate("bash", bashInput, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out, /Jev: tests_failed/);

  const d = lastDecision("bash");
  assertDecisionShape(d);
  assert.equal(d.question, "npm test");
  assert.equal(d.label, "tests_failed");
  assert.equal(d.confidence, 0.9);
});

test("prompt gate: ambiguity warning at p=0.9; decision log populated", async () => {
  const server = await stub({ ambiguous: { probability: 0.9 } });
  const out = await runGate("prompt", { ...promptInput, session_id: "y" }, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out, /Jev: this request reads as ambiguous/);

  const d = lastDecision("prompt");
  assertDecisionShape(d);
  assert.equal(d.question, promptInput.prompt);
  assert.equal(d.label, "ambiguous");
});

test("all four gates emit nothing when ASK_JEV_GATES= is empty", async () => {
  const server = await stub({ safe: { probability: 0.95 }, incomplete: { probability: 0.95 }, result: { choice: "error", probabilities: { error: 0.95 } } });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [name, input] of [["permission", editInput], ["stop", stopInput], ["bash", bashInput], ["prompt", promptInput]]) {
    assert.equal(await runGate(name, input, url, ""), "");
  }
  server.close();
});

test("legacy JEV_GATES= alone still disables gates; ASK_JEV_GATES wins when both are set", async () => {
  const server = await stub({ safe: { probability: 0.95 }, destructive: { probability: 0.1 } });
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = fileURLToPath(new URL("gates/permission.mjs", import.meta.url));

  async function runWithEnv(extraEnv) {
    const child = execFileAsync("node", [script], {
      env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ASK_JEV_REMIND: "0", ...extraEnv },
      encoding: "utf8",
    });
    child.child.stdin.end(JSON.stringify(editInput));
    return (await child).stdout;
  }

  assert.equal(await runWithEnv({ JEV_GATES: "" }), "");
  assert.match(await runWithEnv({ JEV_GATES: "", ASK_JEV_GATES: "permission" }), /"permissionDecision":"allow"/);

  server.close();
});

test("gate in a non-git cwd stays quiet on stderr (git's own errors aren't leaked)", async () => {
  const { stdout, stderr } = await runGateFull("permission", { ...editInput, cwd: "/tmp", transcript_path: "/dev/null" }, "http://127.0.0.1:9", "permission", "/tmp");
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("DESTRUCTIVE.false lists Claude Code scratch dirs as reversible", async () => {
  const { DESTRUCTIVE } = await import("../lib/gate.mjs");
  assert.match(DESTRUCTIVE.false, /\.claude\/plans/, "must mention ~/.claude/plans/");
});
