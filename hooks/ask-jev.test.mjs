import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvents, filterSince, sinceMsFromSpec, recentDecisions, computeStats } from "../lib/stats.mjs";
import { requestError } from "../lib/jev.mjs";

const execFileAsync = promisify(execFile);
const transcript = join(mkdtempSync(join(tmpdir(), "askjev-")), "t.jsonl");
writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":"hi"}}\n');
const logFile = join(mkdtempSync(join(tmpdir(), "askjev-log-")), "jev.log");

function stub(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: handler(JSON.parse(body)) }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
async function runRaw(input, url) {
  const child = execFileAsync("node", ["hooks/ask-jev.mjs"], {
    env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  return (await child).stdout;
}
async function runHook(input, url) {
  return JSON.parse(await runRaw(input, url));
}
const opts = [{ label: "A", description: "a" }, { label: "B", description: "b" }];

test("partial answers: resolved question denies, unresolved re-asked", async () => {
  const server = await stub(({ state, questions }) => (questions.pick
    ? { pick: { choice: "o0", probabilities: { o0: state.pendingQuestion === "Resolved?" ? 0.95 : 0.5 } }, personal: { probability: 0.1 }, destructive: { probability: 0.1 } }
    : {}));
  const out = await runHook({
    tool_name: "AskUserQuestion",
    transcript_path: transcript,
    tool_input: { questions: [{ question: "Resolved?", options: opts }, { question: "Unresolved?", options: opts }] },
  }, `http://127.0.0.1:${server.address().port}`);
  server.close();
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /"Resolved\?" → A/);
  assert.match(reason, /Re-ask the user ONLY the unresolved question/);
  assert.match(reason, /"Unresolved\?"/);

  const decisions = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "decision");
  assert.ok(decisions.some((d) => d.question === "Resolved?" && d.outcome === "answered" && d.label === "A"));
  assert.ok(decisions.some((d) => d.question === "Unresolved?" && d.outcome === "low_confidence"));

  const { stdout } = await execFileAsync("node", ["bin/jev.mjs", "stats", "--json"], { env: { ...process.env, ASK_JEV_LOG_FILE: logFile } });
  const summary = JSON.parse(stdout);
  assert.equal(summary.decisions.by_outcome.answered, decisions.filter((d) => d.outcome === "answered").length);
  assert.equal(summary.decisions.by_outcome.low_confidence, decisions.filter((d) => d.outcome === "low_confidence").length);
});

test("multiSelect: decisive per-option answers join into one label", async () => {
  const server = await stub(() => ({ personal: { probability: 0.1 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } }));
  const out = await runHook({
    tool_name: "AskUserQuestion",
    transcript_path: transcript,
    tool_input: { questions: [{ question: "Pick features", multiSelect: true, options: opts }] },
  }, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /"Pick features" → A \(/);
});

test("duplicate call is silent: one gateway request, one decision line", async () => {
  let calls = 0;
  const server = await stub(() => {
    calls++;
    return { pick: { choice: "o0", probabilities: { o0: 0.95 } }, personal: { probability: 0.1 }, destructive: { probability: 0.1 } };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const input = { tool_name: "AskUserQuestion", session_id: `dedupe-${Math.random()}`, transcript_path: transcript, tool_input: { questions: [{ question: "Dup?", options: opts }] } };
  try {
    await runHook(input, url);
    assert.equal(await runRaw(input, url), "");
  } finally {
    server.close();
  }
  assert.equal(calls, 1);
  const decisions = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "decision" && e.question === "Dup?");
  assert.equal(decisions.length, 1);
});

test("lib/stats.mjs: malformed lines skipped, --since filters, recentDecisions caps to newest N", () => {
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const raw = ["not json", JSON.stringify({ ts: old, kind: "decision", outcome: "answered", question: "Old?" }),
    JSON.stringify({ ts: now, kind: "decision", outcome: "answered", question: "New1?" }),
    JSON.stringify({ ts: now, kind: "decision", outcome: "error", question: "New2?" }), ""].join("\n");

  const events = parseEvents(raw);
  assert.equal(events.length, 3);
  assert.equal(filterSince(events, sinceMsFromSpec("7d")).length, 2);
  const lastOne = recentDecisions(events, 1);
  assert.equal(lastOne.length, 1);
  assert.equal(lastOne[0].question, "New2?");
});

test("lib/stats.mjs: computeStats reports per-gate positive/fallback rates", () => {
  const events = [
    { kind: "decision", gate: "ask", outcome: "answered" },
    { kind: "decision", gate: "ask", outcome: "personal" },
    { kind: "decision", gate: "permission", outcome: "allow" },
    { kind: "decision", gate: "permission", outcome: "ask" },
    { kind: "decision", gate: "bash", outcome: "success" },
    { kind: "decision", gate: "bash", outcome: "tests_failed" },
  ];
  const s = computeStats(events);
  assert.equal(s.decisions.total, 6);
  assert.deepEqual(s.decisions.by_gate.ask, { total: 2, positive: 1, by_outcome: { answered: 1, personal: 1 } });
  assert.deepEqual(s.decisions.by_gate.permission, { total: 2, positive: 1, by_outcome: { allow: 1, ask: 1 } });
  assert.deepEqual(s.decisions.by_gate.bash, { total: 2, positive: 1, by_outcome: { success: 1, tests_failed: 1 } });
  // positive: ask/answered, permission/allow, bash/success = 3 of 6
  assert.equal(s.decisions.positive_pct, 50);
  // fallback: ask/personal (non-answered) + permission/ask = 2 of 6
  assert.equal(s.decisions.fallback_pct, (2 / 6) * 100);
});

test("lib/jev.mjs: askJev retries once on a 5xx gateway response, logs retried:true", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      if (calls === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers: { ok: { probability: 0.5 } } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + "const a = await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q',focus:'f'},criteria:{true:'t',false:'f'}}}, 'test', 2000); "
    + "process.stdout.write(JSON.stringify(a)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...process.env, ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(stdout), { ok: { probability: 0.5 } });

  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.kind === "call" && e.source === "test").at(-1);
  assert.equal(call.status, "ok");
  assert.equal(call.retried, true);
});

test("lib/jev.mjs: a hanging gateway response stays within the requested budget", async () => {
  const server = createServer((req) => {
    req.on("data", () => {}); // không bao giờ res.end() — mô phỏng gateway treo
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const budgetMs = 2000;
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + `const t0 = Date.now(); try { await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q',focus:'f'},criteria:{true:'t',false:'f'}}}, 'test', ${budgetMs}); } catch {} `
    + "process.stdout.write(String(Date.now() - t0)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...process.env, ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  const elapsed = Number(stdout);
  assert.ok(elapsed < budgetMs + 500, `expected well under budgetMs=${budgetMs}, got ${elapsed}ms`);
});

// --- Bidirectional mirror reconciliation: personal/destructive must stay conservative under contradiction ---

async function runRawEnv(input, url, extraEnv) {
  const child = execFileAsync("node", ["hooks/ask-jev.mjs"], {
    env: { ...process.env, AI_GATEWAY_API_KEY: "dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ...extraEnv },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  return (await child).stdout;
}

test("bidirectional: destructive forward/mirror contradiction forces ask (no auto-answer)", async () => {
  // fwd=0.7 destructive, mirror=0.7 reversible → contradiction. Symmetric collapse→0.5 (<0.6) would auto-answer; asymmetric→~0.9 trips the floor.
  const server = await stub(() => ({
    pick: { choice: "o0", probabilities: { o0: 0.99 } },
    personal: { probability: 0.05 }, personal__mirror: { probability: 0.95 },
    destructive: { probability: 0.7 }, destructive__mirror: { probability: 0.7 },
  }));
  const out = await runRaw({ tool_name: "AskUserQuestion", session_id: `dcon-${Math.random()}`, transcript_path: transcript, tool_input: { questions: [{ question: "Delete prod DB?", options: opts }] } }, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.equal(out, ""); // hook stays silent → question goes to the user
  const d = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "decision").at(-1);
  assert.equal(d.outcome, "destructive");
});

test("bidirectional: destructive agreement (low) still lets a confident answer through (no overcorrection)", async () => {
  const server = await stub(() => ({
    pick: { choice: "o0", probabilities: { o0: 0.99 } },
    personal: { probability: 0.05 }, personal__mirror: { probability: 0.95 },
    destructive: { probability: 0.1 }, destructive__mirror: { probability: 0.9 },
  }));
  const out = await runHook({ tool_name: "AskUserQuestion", session_id: `dok-${Math.random()}`, transcript_path: transcript, tool_input: { questions: [{ question: "Rename var?", options: opts }] } }, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /"Rename var\?" → A/);
});

test("bidirectional (safe mode): personal forward/mirror contradiction still defers to the user", async () => {
  // fwd personal=0.6 (defer), mirror says not-personal (twin=1.0). Symmetric collapse→0.38 would auto-answer a personal matter.
  const server = await stub(() => ({
    pick: { choice: "o0", probabilities: { o0: 0.99 } },
    personal: { probability: 0.6 }, personal__mirror: { probability: 1.0 },
    destructive: { probability: 0.05 }, destructive__mirror: { probability: 0.95 },
  }));
  const out = await runRawEnv({ tool_name: "AskUserQuestion", session_id: `pcon-${Math.random()}`, transcript_path: transcript, tool_input: { questions: [{ question: "Brand color?", options: opts }] } }, `http://127.0.0.1:${server.address().port}`, { ASK_JEV_AUTONOMY: "safe" });
  server.close();
  assert.equal(out, ""); // deferred → hook silent, user decides
  const d = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "decision").at(-1);
  assert.equal(d.outcome, "personal");
});

test("cli: wrong input shape fails with the expected shape, not a TypeError", async () => {
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...process.env, AI_GATEWAY_API_KEY: "x" } });
  run.child.stdin.end(JSON.stringify({ task: "t", context: "c", question: "q" }));
  await assert.rejects(run, (err) => /input must be \{"state"/.test(err.stderr) && /got keys: task, context, question/.test(err.stderr));
});

test("requestError: rejects shapes agents invent, accepts documented ones", () => {
  const q = (over) => ({ state: { x: 1 }, questions: { a: { type: "boolean", instructions: { question: "?" }, criteria: { true: "t", false: "f" }, ...over } } });
  const bad = [
    [null, /input must be/],
    [[], /input must be/],
    [{ state: "s", questions: {} }, /input must be/],
    [{ questions: q().questions }, /input must be/],
    [{ state: "s", question: "free text?" }, /got keys: state, question/],
    [q({ type: "classify" }), /questions\.a\.type must be one of/],
    [q({ instructions: undefined }), /questions\.a\.instructions is required/],
    [q({ criteria: undefined }), /questions\.a\.criteria is required/],
    [q({ criteria: ["A", "B"] }), /questions\.a\.criteria is required/],
    [q({ criteria: { yes: "y", no: "n" } }), /needs both "true" and "false"/],
    [q({ type: "choice", criteria: { only: { what: "x" } } }), /needs 2\+ options/],
  ];
  for (const [input, re] of bad) assert.match(requestError(input) ?? "", re, JSON.stringify(input));

  assert.equal(requestError(q()), null);
  assert.equal(requestError(q({ type: "choice", criteria: { a: { what: "x" }, b: "plain string ok" } })), null);
  const skill = readFileSync("skills/ask-jev/SKILL.md", "utf8").match(/```json\n([\s\S]*?)```/)[1];
  assert.equal(requestError(JSON.parse(skill)), null, "SKILL.md example must stay valid");
  assert.equal(requestError(JSON.parse(readFileSync("evals/fixtures/classify-ticket.json", "utf8"))), null);
});
