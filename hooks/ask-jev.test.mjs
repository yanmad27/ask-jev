import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvents, filterSince, filterRepo, normalizeRepo, sinceMsFromSpec, recentDecisions, computeStats } from "../lib/stats.mjs";
import { requestError, provider, endpoint } from "../lib/jev.mjs";

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
async function runRaw(input, url, extraEnv = {}) {
  const child = execFileAsync("node", ["hooks/ask-jev.mjs"], {
    env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ...extraEnv },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  return (await child).stdout;
}
async function runHook(input, url) {
  return JSON.parse(await runRaw(input, url));
}
const opts = [{ label: "A", description: "a" }, { label: "B", description: "b" }];

test("Paseo: hook stands down entirely when PASEO_AGENT_ID is set, even for a confident answer", async () => {
  // In Paseo, AskUserQuestion is a native question permission the user answers in the
  // UI. A Claude Code hook can only "answer" by denying (permissionDecision: "deny"),
  // which Paseo renders as a red "PreToolUse:AskUserQuestion hook error" block — so the
  // hook must emit nothing and let the question reach the user normally.
  const server = await stub(() => ({ pick: { choice: "o0", probabilities: { o0: 0.99 } }, personal: { probability: 0.02 }, destructive: { probability: 0.02 } }));
  const stdout = await runRaw(
    { tool_name: "AskUserQuestion", transcript_path: transcript, tool_input: { questions: [{ question: "Stack?", options: opts }] } },
    `http://127.0.0.1:${server.address().port}`,
    { PASEO_AGENT_ID: "paseo-agent-1" },
  );
  server.close();
  assert.equal(stdout.trim(), "", "under Paseo the hook must emit no permissionDecision");
});

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

  const { stdout } = await execFileAsync("node", ["bin/jev.mjs", "stats", "--json"], { env: { ...cleanEnv(), ASK_JEV_LOG_FILE: logFile } });
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

test("lib/jev.mjs: askJev retries 5xx until success within budget, logs retried + attempts", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      if (calls <= 3) {
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
    + "const a = await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q',focus:'f'},criteria:{true:'t',false:'f'}}}, 'test', 8000); "
    + "process.stdout.write(JSON.stringify(a)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  assert.equal(calls, 4);
  assert.deepEqual(JSON.parse(stdout), { ok: { probability: 0.5, confidence: 0.5 } });

  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.kind === "call" && e.source === "test").at(-1);
  assert.equal(call.status, "ok");
  assert.equal(call.retried, true);
  assert.equal(call.attempts, 4);
});

test("lib/jev.mjs: a gateway that always 503s gives up within budget, with backoff capping the attempts", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { const t = Date.now(); "
    + "await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q'},criteria:{true:'t',false:'f'}}}, 'test-503', 4000).catch(() => {}); "
    + "process.stdout.write(String(Date.now() - t)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  assert.ok(Number(stdout) <= 4000, `took ${stdout}ms`);
  // backoff 300 → 600 → 1200 chặn ở tối đa 4 attempt (backoff cố định 300ms sẽ ra ~8); máy bận → có thể 2–3.
  assert.ok(calls >= 2 && calls <= 4, `calls=${calls}`);
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
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  const elapsed = Number(stdout);
  assert.ok(elapsed < budgetMs + 500, `expected well under budgetMs=${budgetMs}, got ${elapsed}ms`);
});

// --- Bidirectional mirror reconciliation: personal/destructive must stay conservative under contradiction ---

async function runRawEnv(input, url, extraEnv) {
  const child = execFileAsync("node", ["hooks/ask-jev.mjs"], {
    env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile, ...extraEnv },
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
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), AI_GATEWAY_API_KEY: "x" } });
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

test("filterRepo: same repo matches across ssh/https/credentials; other repos and repo-less lines drop out", () => {
  for (const url of ["git@github.com:yanmad27/ask-jev.git", "https://github.com/yanmad27/ask-jev", "https://u:tok@GitHub.com/yanmad27/ask-jev.git/", "ssh://git@github.com/yanmad27/ask-jev.git"]) {
    assert.equal(normalizeRepo(url), "github.com/yanmad27/ask-jev", url);
  }
  assert.equal(normalizeRepo(undefined), null);
  const events = [{ repo: "git@github.com:yanmad27/ask-jev.git" }, { repo: "https://github.com/yanmad27/ask-jev" }, { repo: "git@github.com:tini-works/kiosk-app.git" }, {}];
  assert.equal(filterRepo(events, "https://github.com/yanmad27/ask-jev.git").length, 2);
  assert.deepEqual(filterRepo(events, null), [{}]);
});

// --- Providers: typesafe (default) vs vercel (legacy, chọn theo tiền tố key) ---

function recorder(replies) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const [status, headers, json] = replies[Math.min(seen.length, replies.length) - 1];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const callJev = (key, url, extraEnv = {}) => {
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + "const r = await askJev(process.env.K, {x:1}, {ok:{type:'boolean',instructions:{question:'q'},criteria:{true:'t',false:'f'}}}, 'test-provider', 6000).catch((e) => ({error: e.message})); "
    + "process.stdout.write(JSON.stringify(r)); });";
  return execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), K: key, ASK_JEV_PROVIDER: "", ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: logFile, ...extraEnv },
    encoding: "utf8",
  }).then(({ stdout }) => JSON.parse(stdout));
};
const yes = { ok: { probability: 0.9 }, ok__mirror: { probability: 0.1 } };

test("provider: non-vck key → typesafe request (Bearer, body.model, type noul, no ai-* headers); noul maps to probability", async () => {
  const { server, seen, url } = await recorder([[200, {}, { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 }, ok__mirror: { type: "noul", noul: 0.1 } } }]]);
  const out = await callJev("tsk_abc", url);
  server.close();
  assert.equal(seen[0].headers.authorization, "Bearer tsk_abc");
  assert.ok(!Object.keys(seen[0].headers).some((h) => h.startsWith("ai-")));
  assert.equal(seen[0].body.model, "jev-latest");
  assert.equal(seen[0].body.questions.ok.type, "noul");
  assert.equal(seen[0].body.questions.ok__mirror.type, "noul");
  assert.equal(out.ok.probability, 0.9);
  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.source === "test-provider").at(-1);
  assert.equal(call.provider, "typesafe");
  assert.equal(call.api_model, "jev-1.13.0");
});

test("provider: vck_ key → exact legacy Vercel request (headers, body without model, boolean type)", async () => {
  const { server, seen, url } = await recorder([[200, {}, { answers: yes }]]);
  const out = await callJev("vck_abc", url);
  server.close();
  const h = seen[0].headers;
  assert.equal(seen[0].url, "/");
  assert.equal(h.authorization, "Bearer vck_abc");
  assert.equal(h["ai-model-id"], "typesafe-ai/jev");
  assert.equal(h["ai-gateway-protocol-version"], "0.0.1");
  assert.equal(h["ai-evaluation-model-specification-version"], "4");
  assert.deepEqual(Object.keys(seen[0].body), ["state", "questions"]);
  assert.equal(seen[0].body.questions.ok.type, "boolean");
  assert.equal(out.ok.probability, 0.9);
});

test("provider: ASK_JEV_PROVIDER=vercel overrides key inference", async () => {
  const { server, seen, url } = await recorder([[200, {}, { answers: yes }]]);
  await callJev("tsk_abc", url, { ASK_JEV_PROVIDER: "vercel" });
  server.close();
  assert.equal(seen[0].headers["ai-model-id"], "typesafe-ai/jev");
});

test("typesafe: 429 is retried honoring retry-after; 401 explains where keys come from", async () => {
  const { server, seen, url } = await recorder([[429, { "retry-after": "1" }, { error: "slow down" }], [200, {}, { answers: { ok: { noul: 0.9 }, ok__mirror: { noul: 0.1 } } }]]);
  const t = Date.now();
  const out = await callJev("tsk_abc", url);
  server.close();
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - t >= 1000, "waited for retry-after");
  assert.equal(out.ok.probability, 0.9);

  const bad = await recorder([[401, {}, { error: "bad key" }]]);
  const err = await callJev("vck_abc", bad.url, { ASK_JEV_PROVIDER: "typesafe" });
  bad.server.close();
  assert.match(err.error, /console\.typesafe\.ai\/keys/);
  assert.match(err.error, /ASK_JEV_PROVIDER=vercel/);
  assert.doesNotMatch(err.error, /gateway/);
});

test("hook end-to-end on typesafe: a noul-only answer drives the decision via probability", async () => {
  const { server, seen, url } = await recorder([[200, {}, { answers: { pick: { choice: "o0", probabilities: { o0: 0.95 } }, personal: { noul: 0.1 }, personal__mirror: { noul: 0.9 }, destructive: { noul: 0.1 }, destructive__mirror: { noul: 0.9 } } }]]);
  const out = JSON.parse(await runRawEnv({ tool_name: "AskUserQuestion", session_id: `ts-${Math.random()}`, transcript_path: transcript, tool_input: { questions: [{ question: "TS?", options: opts }] } }, url, { ASK_JEV_API_KEY: "tsk_abc" }));
  server.close();
  assert.equal(seen[0].body.model, "jev-latest");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /"TS\?" → A/);
});

test("provider/endpoint: defaults per provider, inference, legacy var, case-insensitive and unknown ASK_JEV_PROVIDER", () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ASK_)?JEV_|^(TYPESAFE|AI_GATEWAY)_API_KEY$/.test(k)) delete process.env[k];
  try {
    assert.deepEqual(endpoint("typesafe"), { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" });
    assert.deepEqual(endpoint("vercel"), { url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", model: "typesafe-ai/jev" });
    assert.equal(provider("vck_x"), "vercel");
    assert.equal(provider("tsk_x"), "typesafe");
    process.env.AI_GATEWAY_API_KEY = "eyJoidc";
    assert.equal(provider("eyJoidc"), "vercel");
    process.env.TYPESAFE_API_KEY = "eyJoidc";
    assert.equal(provider("eyJoidc"), "typesafe");
    process.env.ASK_JEV_PROVIDER = "Vercel";
    assert.equal(provider("tsk_x"), "vercel");
    for (const bad of ["constructor", "nope"]) {
      process.env.ASK_JEV_PROVIDER = bad;
      assert.throws(() => provider("tsk_x"), /ASK_JEV_PROVIDER must be one of typesafe, vercel/);
    }
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("cli on typesafe: boolean answer is exactly {probability, confidence} — no raw noul/type", async () => {
  const { server, url } = await recorder([[200, {}, { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 }, ok__mirror: { type: "noul", noul: 0.1 } } }]]);
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), TYPESAFE_API_KEY: "tsk_abc", ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: logFile } });
  run.child.stdin.end(JSON.stringify({ state: { x: 1 }, questions: { ok: { type: "boolean", instructions: { question: "q" }, criteria: { true: "t", false: "f" } } } }));
  const { stdout } = await run;
  server.close();
  const a = JSON.parse(stdout);
  assert.deepEqual(Object.keys(a.ok).sort(), ["confidence", "probability"]);
  assert.ok(Math.abs(a.ok.probability - 0.9) < 1e-9);
  assert.ok(Math.abs(a.ok.confidence - 0.9) < 1e-9);
});

test("401 hint on the vercel path when the key is not a Vercel key", async () => {
  const bad = await recorder([[401, {}, { error: "bad" }]]);
  const err = await callJev("tsk_abc", bad.url, { ASK_JEV_PROVIDER: "vercel" });
  bad.server.close();
  assert.match(err.error, /ASK_JEV_PROVIDER=typesafe/);
});
