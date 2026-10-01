import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { askJev, logEvent, runInvocation, billingNoteShown, classifyError, redactError, stripUrlSecrets, DEFAULT_BUDGET_MS, HOOK_MARGIN_MS } from "../lib/jev.mjs";
import * as vendor from "../paseo-plugin/server/vendor/jev.mjs";
import { VERSION } from "../lib/version.mjs";
import { VERSION as VENDOR_VERSION } from "../paseo-plugin/server/vendor/version.mjs";
import { computeStats, parseEvents } from "../lib/stats.mjs";

const execFileAsync = promisify(execFile);
const pluginVersion = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8")).version;
const STAMPED = ["schema", "version", "invocation_id", "session_id", "autonomy", "threshold"];
const KEY = "tsk_live_abcdefghijklmnopqrstuvwxyz0123456789SECRET";

const Q = { q: { type: "boolean", instructions: { question: "x" }, criteria: { true: "yes", false: "no" } } };
const CHOICE = { pick: { type: "choice", instructions: { question: "x" }, criteria: { o0: { what: "a", not_for: "b" }, o1: { what: "b", not_for: "a" } } } };

function stub(handler) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  server.closeAll = () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r)));
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const url = (s) => `http://127.0.0.1:${s.address().port}/`;
const ok = (res, answers) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ answers })));
const fail = (status, body) => (_req, res) => (res.writeHead(status), res.end(body));

// ASK_JEV_* is read at call time → in-process tests swap env per test and restore after.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(process.env)) if (/^(ASK_)?JEV_|^(TYPESAFE|AI_GATEWAY)_API_KEY$|^PASEO_/.test(k)) (saved[k] = process.env[k], delete process.env[k]);
  const touched = Object.keys(vars);
  const before = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of touched) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
    Object.assign(process.env, saved);
  }
}
const newLog = () => join(mkdtempSync(join(tmpdir(), "schema-log-")), "jev.log");
const rows = (path) => parseEvents(readFileSync(path, "utf8"));
const baseEnv = (path, server) => ({ ASK_JEV_LOG_FILE: path, ASK_JEV_API_KEY: KEY, ASK_JEV_PROVIDER: "typesafe", ...(server ? { ASK_JEV_API_URL: url(server) } : {}) });

test("D.5: fresh log is created 0600 and a pre-existing 0644 log is tightened on open", async () => {
  const fresh = newLog();
  await withEnv({ ASK_JEV_LOG_FILE: fresh }, () => logEvent({ kind: "diagnostic" }));
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  const old = newLog();
  writeFileSync(old, '{"kind":"decision"}\n', { mode: 0o644 });
  chmodSync(old, 0o644);
  assert.equal(statSync(old).mode & 0o777, 0o644);
  await withEnv({ ASK_JEV_LOG_FILE: old }, () => logEvent({ kind: "diagnostic" }));
  assert.equal(statSync(old).mode & 0o777, 0o600);
  assert.equal(rows(old).length, 2);
});

test("version: lib and the generated vendor copy equal .claude-plugin/plugin.json", () => {
  assert.equal(VERSION, pluginVersion);
  assert.equal(VENDOR_VERSION, pluginVersion);
});

async function runCli(path, server, input) {
  const child = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), ...baseEnv(path, server) }, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify(input));
  return child;
}

test("every writer family that goes through logEvent is stamped (askJev call, legacy gate, CLI, Paseo-style via vendor copy, outcome, standdown, diagnostic, provider_error)", async () => {
  const path = newLog();
  const server = await stub((_req, res) => ok(res, { q: { noul: 0.9 }, q__mirror: { noul: 0.1 } }));
  try {
    await withEnv({ ...baseEnv(path, server), ASK_JEV_AUTONOMY: "safe", ASK_JEV_ASK_THRESHOLD: "0.7" }, async () => {
      await askJev(KEY, { a: 1 }, Q, "hook");
      logEvent({ kind: "decision", source: "hook", gate: "bash", outcome: "success", session_id: "sess-gate" });
      logEvent({ kind: "outcome", source: "hook", question_index: 0, chosen: ["A"], agreement: "agree" });
      logEvent({ kind: "standdown", source: "hook", gate: "ask", reason: "paseo" });
      logEvent({ kind: "diagnostic", source: "hook", outcome: "error" });
      logEvent({ kind: "provider_error", source: "hook", error_class: "server", fail_open: true });
      await vendor.runInvocation({ invocation_id: "agent1:req1", session_id: "agent1", source: "paseo" }, async () => {
        vendor.logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome: "advised", mode: "advisory" });
        vendor.logEvent({ kind: "outcome", source: "paseo", chosen: ["B"] });
      });
    });
    await runCli(path, server, { state: { a: 1 }, questions: Q });
  } finally {
    await server.closeAll();
  }
  const all = rows(path);
  const kinds = new Set(all.map((r) => r.kind));
  for (const k of ["call", "decision", "outcome", "standdown", "diagnostic", "provider_error"]) assert.ok(kinds.has(k), `missing ${k} row`);
  assert.ok(all.some((r) => r.source === "cli" && r.kind === "decision"), "CLI decision row");
  assert.ok(all.length >= 10);
  for (const r of all) {
    for (const f of STAMPED) assert.ok(f in r, `${r.kind}/${r.source} row lacks ${f}: ${JSON.stringify(r)}`);
    assert.equal(r.schema, 2);
    assert.equal(r.version, pluginVersion);
    assert.equal(typeof r.invocation_id, "string");
    assert.ok(r.session_id === null || typeof r.session_id === "string");
    assert.ok(["full", "safe"].includes(r.autonomy));
    assert.ok(r.threshold === null || typeof r.threshold === "number");
  }
  const inProc = all.filter((r) => r.source === "hook" && r.kind !== "decision" || r.kind === "call" && r.source === "hook");
  for (const r of inProc) assert.equal([r.autonomy, r.threshold].join(), "safe,0.7");
  const paseo = all.filter((r) => r.source === "paseo");
  assert.equal(paseo.length, 2);
  for (const r of paseo) assert.deepEqual([r.invocation_id, r.session_id], ["agent1:req1", "agent1"]);
  assert.equal(all.find((r) => r.gate === "bash").session_id, "sess-gate"); // writer-supplied value wins over context default
  const cliRows = all.filter((r) => r.source === "cli");
  assert.equal(new Set(cliRows.map((r) => r.invocation_id)).size, 1, "one invocation id per CLI process run");
});

test("overlapping invocation contexts do not cross-contaminate stamped fields", async () => {
  const path = newLog();
  const server = await stub((_req, res) => setTimeout(() => ok(res, { q: { noul: 0.9 }, q__mirror: { noul: 0.1 } }), 30));
  try {
    await withEnv(baseEnv(path, server), async () => {
      const run = (id, sid, delay) =>
        runInvocation({ invocation_id: id, session_id: sid, source: "paseo", threshold: id === "A" ? 0.5 : 0.9 }, async () => {
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, delay));
            logEvent({ kind: "diagnostic", tag: id, i });
          }
          await askJev(KEY, {}, Q, "paseo");
          logEvent({ kind: "diagnostic", tag: id, after: "askJev" });
        });
      await Promise.all([run("A", "sa", 5), run("B", "sb", 7), run("C", "sc", 3)]);
    });
  } finally {
    await server.closeAll();
  }
  const want = { A: ["sa", 0.5], B: ["sb", 0.9], C: ["sc", 0.9] };
  let checked = 0;
  for (const r of rows(path).filter((x) => x.tag)) {
    assert.deepEqual([r.session_id, r.threshold], want[r.tag], JSON.stringify(r));
    assert.equal(r.invocation_id, r.tag);
    checked++;
  }
  assert.equal(checked, 12);
  const calls = rows(path).filter((r) => r.kind === "call");
  assert.deepEqual(calls.map((c) => c.invocation_id).sort(), ["A", "B", "C"]);
  for (const c of calls) assert.equal(c.session_id, want[c.invocation_id][0]);
});

const FAILURES = [
  { name: "HTTP 500", handler: fail(500, "boom"), cls: "server", status: 500, billing: false },
  { name: "HTTP 402", handler: fail(402, "pay up"), cls: "billing", status: 402, billing: true },
  { name: "body mentions credit (status 400)", handler: fail(400, '{"error":"insufficient credit"}'), cls: "billing", status: 400, billing: true },
  { name: "timeout", handler: () => {}, cls: "timeout", status: undefined, billing: false, budget: 1200 },
];
for (const f of FAILURES) {
  test(`provider failure (${f.name}) → call{error,error_class} + exactly one provider_error{fail_open}`, async () => {
    const path = newLog();
    const server = await stub(f.handler);
    try {
      await withEnv(baseEnv(path, server), async () => {
        const err = await askJev(KEY, {}, Q, "hook", f.budget ?? 1500, undefined, { gate: "ask", question_index: 2 }).then(() => null, (e) => e);
        assert.ok(err, "askJev must still throw so callers fail open");
        assert.equal(err.errorClass, f.cls);
        assert.equal(err.notice, f.billing ? "billing" : "generic");
      });
    } finally {
      await server.closeAll();
    }
    const all = rows(path);
    const call = all.filter((r) => r.kind === "call");
    const pe = all.filter((r) => r.kind === "provider_error");
    assert.equal(call.length, 1);
    assert.equal(call[0].status, "error");
    assert.equal(call[0].error_class, f.cls);
    assert.equal(call[0].http_status, f.status);
    assert.equal(pe.length, 1);
    assert.equal(pe[0].fail_open, true);
    assert.equal(pe[0].billing, f.billing);
    assert.equal(pe[0].error_class, f.cls);
    assert.equal(pe[0].gate, "ask");
    assert.equal(pe[0].question_index, 2);
    assert.equal(pe[0].invocation_id, call[0].invocation_id);
  });
}

test("classifyError: network failures and unknown errors", () => {
  assert.equal(classifyError(new TypeError("fetch failed")), "network");
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 401 })), "auth");
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 429 })), "rate_limit");
  assert.equal(classifyError(new Error("something odd")), "other");
});

test("billing note once per session across two separate hook processes (state lives in the log)", async () => {
  const path = newLog();
  const server = await stub(fail(402, "payment required"));
  const script = `import { askJev, runInvocation } from ${JSON.stringify(new URL("../lib/jev.mjs", import.meta.url).href)};
const sid = process.argv[1];
await runInvocation({ session_id: sid }, () => askJev("k-12345678", {}, ${JSON.stringify(Q)}, "hook", 1500).catch((e) => process.stdout.write(e.notice)));`;
  const runProc = async (sid) => (await execFileAsync("node", ["--input-type=module", "-e", script, sid], { env: { ...cleanEnv(), ...baseEnv(path, server) }, encoding: "utf8" })).stdout;
  try {
    assert.equal(billingNoteShown("S1"), false);
    assert.equal(await runProc("S1"), "billing");
    assert.equal(await runProc("S1"), "generic");
    assert.equal(await runProc("S2"), "billing");
  } finally {
    await server.closeAll();
  }
  await withEnv({ ASK_JEV_LOG_FILE: path }, () => {
    assert.equal(billingNoteShown("S1"), true);
    assert.equal(billingNoteShown("S2"), true);
    assert.equal(billingNoteShown("S3"), false);
    assert.equal(billingNoteShown(null), false);
  });
  const pe = rows(path).filter((r) => r.kind === "provider_error" && r.session_id === "S1");
  assert.deepEqual(pe.map((r) => r.notified_user), [true, false]);
});

test("provider error echoing the API key and an oversized body: call.error and provider_error.message are redacted and capped", async () => {
  const path = newLog();
  const body = `invalid key ${KEY} Authorization: Bearer ${KEY} api_key=${KEY} ${"x".repeat(5000)}`;
  const server = await stub(fail(500, body));
  try {
    await withEnv(baseEnv(path, server), () => askJev(KEY, {}, Q, "hook", 1500).catch(() => {}));
  } finally {
    await server.closeAll();
  }
  const all = rows(path);
  for (const text of [all.find((r) => r.kind === "call").error, all.find((r) => r.kind === "provider_error").message]) {
    assert.ok(text.length <= 200, `length ${text.length}`);
    assert.ok(!text.includes(KEY) && !text.includes("abcdefghijklmnop"), text);
  }
  assert.ok(!readFileSync(path, "utf8").includes("SECRET"));
});

test("redactError / stripUrlSecrets: keys, bearer tokens, URL userinfo/query/fragment", () => {
  assert.equal(redactError("Bearer abc.def-123 failed"), "[redacted] failed");
  assert.match(redactError("token: abcdef123"), /\[redacted\]/);
  assert.ok(!redactError("see https://u:pw@host.example/p?token=zzz#frag now").match(/pw|zzz|frag|u:/));
  assert.equal(stripUrlSecrets("https://user:tok@github.com/o/r.git?x=1#f"), "https://github.com/o/r.git");
  assert.equal(stripUrlSecrets("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.ok(redactError("y".repeat(900)).length <= 200);
});

test("repo remote URL is never stored with userinfo/query/fragment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-repo-"));
  const path = newLog();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://user:ghp_secrettoken@github.com/o/r.git?access_token=abc#frag"]);
  const script = `import { logEvent } from ${JSON.stringify(new URL("../lib/jev.mjs", import.meta.url).href)}; logEvent({ kind: "diagnostic" });`;
  await execFileAsync("node", ["--input-type=module", "-e", script], { cwd: dir, env: { ...cleanEnv(), ASK_JEV_LOG_FILE: path } });
  const text = readFileSync(path, "utf8");
  assert.equal(rows(path)[0].repo, "https://github.com/o/r.git");
  assert.ok(!/ghp_|user:|access_token|frag/.test(text));
});

test("no state payload or transcript content reaches the log (sentinel scan over success and failure runs)", async () => {
  const path = newLog();
  const SENTINEL = "SENTINEL-state-7f3a9c-do-not-log";
  let n = 0;
  const server = await stub((_req, res) => (n++ % 2 ? fail(500, `echo ${SENTINEL.slice(0, 8)}`)(_req, res) : ok(res, { q: { noul: 0.9 }, q__mirror: { noul: 0.1 } })));
  try {
    await withEnv(baseEnv(path, server), async () => {
      const state = { task: { current_task: SENTINEL }, conversation: { turns: [`User: ${SENTINEL}`] } };
      await askJev(KEY, state, Q, "hook", 1500, { task: 40, conversation: 60 });
      await askJev(KEY, state, Q, "hook", 1500, { task: 40, conversation: 60 }).catch(() => {});
    });
  } finally {
    await server.closeAll();
  }
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes(SENTINEL));
  const call = rows(path).find((r) => r.kind === "call");
  assert.deepEqual(call.state_sizes, { task: 40, conversation: 60 });
});

test("internal provider deadline stays below the hook timeouts by the margin (host kill before the deadline is residual risk: no row is written)", async () => {
  const hooks = JSON.parse(readFileSync("hooks/hooks.json", "utf8"));
  const askHook = hooks.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) => /ask-jev\.mjs/.test(h.command));
  assert.ok(askHook);
  const registered = [askHook.timeout, ...[...readFileSync("hooks/self-register.mjs", "utf8").matchAll(/timeout:\s*(\d+)/g)].map((m) => Number(m[1]))];
  for (const t of registered) assert.ok(t * 1000 >= DEFAULT_BUDGET_MS + HOOK_MARGIN_MS, `hook timeout ${t}s too close to ${DEFAULT_BUDGET_MS}ms`);

  const server = await stub(() => {});
  const path = newLog();
  try {
    const t0 = Date.now();
    await withEnv(baseEnv(path, server), () => askJev(KEY, {}, Q, "hook", 1200).catch(() => {}));
    assert.ok(Date.now() - t0 < 1200 + 400, `took ${Date.now() - t0}ms`);
  } finally {
    await server.closeAll();
  }
  assert.equal(rows(path).filter((r) => r.kind === "provider_error").length, 1);
});

test("computeStats on a mixed v1 + v2 log yields the D.4 keys without throwing; agreement only from outcome rows with recommended", () => {
  const events = [
    // v1
    { kind: "call", source: "hook", status: "ok", latency_ms: 100 },
    { kind: "call", source: "hook", status: "error", latency_ms: 300, error: "gateway 503" },
    { kind: "decision", source: "hook", gate: "ask", outcome: "answered", confidence: 0.9 },
    { kind: "decision", source: "hook", gate: "ask", outcome: "personal" },
    { kind: "decision", source: "paseo", gate: "ask", outcome: "answered" },
    { kind: "decision", source: "hook", gate: "bash", outcome: "success" },
    { kind: "user_choice", chosen: ["A"], kind_of_answer: "option" },
    { kind: "diagnostic", source: "paseo", gate: "ask", outcome: "paseo_standdown" },
    // v2
    { schema: 2, kind: "call", source: "cli", status: "error", latency_ms: 50, error_class: "billing" },
    { schema: 2, kind: "call", source: "hook", status: "ok", latency_ms: 200 },
    { schema: 2, kind: "provider_error", source: "cli", error_class: "billing", fail_open: true },
    { schema: 2, kind: "decision", source: "hook", gate: "ask", mode: "advisory", outcome: "advised", strength: "strong" },
    { schema: 2, kind: "decision", source: "hook", gate: "ask", mode: "advisory", outcome: "advised", strength: "weak" },
    { schema: 2, kind: "decision", source: "hook", gate: "ask", mode: "advisory", outcome: "advice_unavailable", reason: "billing" },
    { schema: 2, kind: "decision", source: "cli", gate: "cli", outcome: "true", confidence: 0.95, threshold: 0.8 },
    { schema: 2, kind: "decision", source: "cli", gate: "cli", outcome: "a", confidence: 0.4, threshold: 0.8 },
    { schema: 2, kind: "outcome", chosen: ["A"], recommended: ["A"], agreement: "agree" },
    { schema: 2, kind: "outcome", chosen: ["B"], recommended: ["A"], agreement: "disagree" },
    { schema: 2, kind: "outcome", chosen: ["A", "C"], recommended: ["A", "B"], agreement: "partial" },
    { schema: 2, kind: "outcome", chosen: ["typed"], recommended: ["A"], agreement: "free_text" },
    { schema: 2, kind: "outcome", chosen: ["A"], recommended: null, agreement: "no_advice" },
    { schema: 2, kind: "outcome", chosen: ["A"], recommended: null, agreement: "agree" },
    { schema: 2, kind: "standdown", reason: "paseo", gate: "ask" },
  ];
  const s = computeStats(events);
  assert.equal(s.schema, 2);
  assert.deepEqual([s.calls.total, s.calls.ok, s.calls.error], [4, 2, 2]);
  assert.equal(s.calls.error_rate, 0.5);
  assert.deepEqual(s.calls.by_error_class, { uncategorized: 1, billing: 1 });
  assert.deepEqual(s.calls.by_source.cli, { calls: 1, errors: 1, error_rate: 1 });
  assert.equal(s.calls.by_source.paseo.calls, 0);
  assert.equal(s.decisions.total, 9);
  assert.equal(s.decisions.by_source.cli.decisions, 2);
  assert.equal(s.decisions.by_source.paseo.decisions, 1);
  assert.deepEqual(s.advisory, { questions: 3, advised: 2, advice_unavailable: 1, unavailable_by_reason: { billing: 1 }, strong: 1, weak: 1 });
  assert.deepEqual(s.legacy_autonomous, { total: 3, by_outcome: { answered: 2, personal: 1 } });
  assert.equal(s.human_answers, 7);
  assert.equal(s.user_overrides, s.human_answers);
  assert.deepEqual(s.agreement, { compared: 3, agree: 1, disagree: 1, partial: 1, agreement_pct: (1 / 3) * 100 });
  assert.deepEqual(s.standdowns, { total: 2, by_reason: { paseo: 2 } });
  assert.deepEqual(s.provider_errors, { total: 1, by_class: { billing: 1 } });
  assert.equal(s.fallbacks, 3 /* personal, advice_unavailable, cli below threshold */);
  assert.ok(!("paseo_standdown" in s.decisions.by_outcome));
  assert.doesNotThrow(() => computeStats([{}, { kind: "outcome" }, { kind: "decision" }, { kind: "call" }]));
});
