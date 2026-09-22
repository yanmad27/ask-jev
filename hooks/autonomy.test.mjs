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
const transcript = join(mkdtempSync(join(tmpdir(), "autonomy-")), "t.jsonl");
writeFileSync(transcript, '{"type":"user","message":{"content":"please refactor the parser"}}\n{"type":"assistant","message":{"content":"ok"}}\n');
const logFile = join(mkdtempSync(join(tmpdir(), "autonomy-log-")), "jev.log");

/** responder(questionKeys) => answers, so one stub server can answer several sequential calls differently. */
function dynamicStub(responder) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: responder(Object.keys(parsed.questions)) }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function run(script, input, url, mode) {
  const path = fileURLToPath(new URL(script, import.meta.url));
  const child = execFileAsync("node", [path], {
    env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ASK_JEV_AUTONOMY: mode, ASK_JEV_REMIND: "0", ASK_JEV_GATES: "permission,stop,bash,prompt" },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  return (await child).stdout;
}

const askInput = {
  tool_name: "AskUserQuestion", session_id: `a-${Math.random()}`, transcript_path: transcript,
  tool_input: { questions: [{ question: "Merge now?", options: [{ label: "yes", description: "merge now" }, { label: "no", description: "wait" }] }] },
};

test("ask-jev: personal falls back in safe, not in full (destructive stays low)", async () => {
  const answers = () => ({ pick: { choice: "o0", probabilities: { o0: 0.95 } }, personal: { probability: 0.9 }, destructive: { probability: 0.1 } });
  const safeServer = await dynamicStub(answers);
  const safeOut = await run("ask-jev.mjs", askInput, `http://127.0.0.1:${safeServer.address().port}`, "safe");
  safeServer.close();
  assert.equal(safeOut, ""); // personal wins in safe → no answer

  const fullServer = await dynamicStub(answers);
  const fullOut = await run("ask-jev.mjs", { ...askInput, session_id: `a-${Math.random()}` }, `http://127.0.0.1:${fullServer.address().port}`, "full");
  fullServer.close();
  assert.match(fullOut, /Jev answered/); // personal ignored in full
});

test("ask-jev: destructive (p=0.7) always hands to the user, both modes", async () => {
  const answers = () => ({ pick: { choice: "o0", probabilities: { o0: 0.95 } }, personal: { probability: 0.1 }, destructive: { probability: 0.7 } });
  for (const mode of ["safe", "full"]) {
    const server = await dynamicStub(answers);
    const out = await run("ask-jev.mjs", { ...askInput, session_id: `a-${Math.random()}` }, `http://127.0.0.1:${server.address().port}`, mode);
    server.close();
    assert.equal(out, "");
  }
});

test("stop gate (full): blocks with an answer when the final message asks 'should I…?' and Jev says yes_proceed", async () => {
  const responder = (keys) => {
    if (keys.includes("incomplete")) return { incomplete: { probability: 0.2 } };
    if (keys.includes("asksUser")) return { asksUser: { probability: 0.9 } };
    return { resolve: { choice: "yes_proceed", probabilities: { yes_proceed: 0.85, no_stop: 0.1, needs_user: 0.05 } } };
  };
  const server = await dynamicStub(responder);
  const input = { session_id: `s-${Math.random()}`, transcript_path: transcript, cwd: process.cwd(), last_assistant_message: "Should I merge this now?" };
  const out = await run("gates/stop.mjs", input, `http://127.0.0.1:${server.address().port}`, "full");
  server.close();
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /proceed/);
});

test("stop gate (full): caps consecutive auto-continue blocks at 3 (security fix)", async () => {
  const sessionId = `cap-${Math.random()}`;
  const responder = (keys) => {
    if (keys.includes("incomplete")) return { incomplete: { probability: 0.2 } };
    if (keys.includes("asksUser")) return { asksUser: { probability: 0.9 } };
    return { resolve: { choice: "yes_proceed", probabilities: { yes_proceed: 0.9, no_stop: 0.05, needs_user: 0.05 } } };
  };
  const input = { session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), last_assistant_message: "Should I proceed?" };
  const outs = [];
  for (let i = 0; i < 4; i++) {
    const server = await dynamicStub(responder);
    outs.push(await run("gates/stop.mjs", input, `http://127.0.0.1:${server.address().port}`, "full"));
    server.close();
  }
  assert.ok(outs.slice(0, 3).every((o) => JSON.parse(o).decision === "block"), "first 3 consecutive turns auto-continue");
  assert.equal(outs[3], "", "4th consecutive auto-continue is capped — stop proceeds instead of blocking forever");
});

test("prompt gate (full): never emits an 'ask' instruction, only proceed/assume", async () => {
  const input = { session_id: `p-${Math.random()}`, prompt: "please refactor the auth module completely", transcript_path: transcript, cwd: process.cwd() };
  for (const p of [0.9, 0.2]) {
    const server = await dynamicStub(() => ({ literal: { probability: p } }));
    const out = await run("gates/prompt.mjs", input, `http://127.0.0.1:${server.address().port}`, "full");
    server.close();
    assert.doesNotMatch(out, /ask (a |one )?clarifying question/);
  }
});

function lastPermissionDecision() {
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return lines.filter((e) => e.kind === "decision" && e.gate === "permission").at(-1);
}

const editInput = { tool_name: "Edit", transcript_path: transcript, cwd: process.cwd(), tool_input: { file_path: "a.js" } };

test("permission (full): safe below threshold but destructive=0.1 still allows — destructive is the hard floor, not safe (middle-band fix)", async () => {
  const server = await dynamicStub(() => ({ safe: { probability: 0.4 }, destructive: { probability: 0.1 } }));
  const out = await run("gates/permission.mjs", { ...editInput, session_id: `p-${Math.random()}` }, `http://127.0.0.1:${server.address().port}`, "full");
  server.close();
  assert.match(out, /"permissionDecision":"allow"/);
  assert.equal(lastPermissionDecision().label, "not_destructive");
});

test("permission (full): destructive=0.45 (0.3-0.6 band) still asks as maybe_destructive", async () => {
  const server = await dynamicStub(() => ({ safe: { probability: 0.4 }, destructive: { probability: 0.45 } }));
  const out = await run("gates/permission.mjs", { ...editInput, session_id: `p-${Math.random()}` }, `http://127.0.0.1:${server.address().port}`, "full");
  server.close();
  assert.match(out, /"permissionDecision":"ask"/);
  assert.equal(lastPermissionDecision().label, "maybe_destructive");
});

test("permission (safe): safe=0.4 destructive=0.1 still asks — the full-only fix does not leak into safe mode", async () => {
  const server = await dynamicStub(() => ({ safe: { probability: 0.4 }, destructive: { probability: 0.1 } }));
  const out = await run("gates/permission.mjs", { ...editInput, session_id: `p-${Math.random()}` }, `http://127.0.0.1:${server.address().port}`, "safe");
  server.close();
  assert.match(out, /"permissionDecision":"ask"/);
});

test("permission: safe=0.85 destructive=0.1 allows in full (threshold 0.8), asks in safe (threshold 0.9, below it regardless of low destructive)", async () => {
  const input = { tool_name: "Edit", transcript_path: transcript, cwd: process.cwd(), tool_input: { file_path: "a.js" } };
  const fullServer = await dynamicStub(() => ({ safe: { probability: 0.85 }, destructive: { probability: 0.1 } }));
  const fullOut = await run("gates/permission.mjs", input, `http://127.0.0.1:${fullServer.address().port}`, "full");
  fullServer.close();
  assert.match(fullOut, /"permissionDecision":"allow"/);

  const safeServer = await dynamicStub(() => ({ safe: { probability: 0.85 }, destructive: { probability: 0.1 } }));
  const safeOut = await run("gates/permission.mjs", input, `http://127.0.0.1:${safeServer.address().port}`, "safe");
  safeServer.close();
  assert.match(safeOut, /"permissionDecision":"ask"/);
});
