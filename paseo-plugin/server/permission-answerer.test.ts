import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPermissionAnswerer } from "./permission-answerer";
import requestedSingle from "./__fixtures__/requested-single.json" with { type: "json" };
import requestedMulti from "./__fixtures__/requested-multi.json" with { type: "json" };
import requestedMultiselect from "./__fixtures__/requested-multiselect.json" with { type: "json" };
import requestedPartial from "./__fixtures__/requested-partial.json" with { type: "json" };

// Hermetic env: a throwaway HOME (no real CLAUDE.md/settings.json bleeding in) and a
// per-test log file. No real Jev/typesafe network calls — global.fetch is always mocked.
let logFile: string;
before(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "paseo-answerer-home-"));
  process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  delete process.env.ASK_JEV_PROVIDER;
});
beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "paseo-answerer-log-")), "jev.log");
  process.env.ASK_JEV_LOG_FILE = logFile;
});

function readLog(): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeServer() {
  const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
  const server = {
    on(name: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers[name] = handler;
      return () => {
        delete handlers[name];
      };
    },
  };
  return { server: server as never, handlers };
}

interface MockPaseo {
  paseo: { agents: { ref(id: string): { timeline: { refetch: () => Promise<unknown>; append: (item: unknown) => Promise<unknown> }; respondToPermission: (opts: { requestId: string; response: unknown }) => Promise<void> } } };
  responded: Array<{ requestId: string; response: unknown }>;
  appended: unknown[];
}

function makeContext(
  timelineEntries: unknown[] | (() => Promise<unknown[]>),
  opts: { onRespond?: () => Promise<void> | void } = {},
): MockPaseo {
  const responded: Array<{ requestId: string; response: unknown }> = [];
  const appended: unknown[] = [];
  const handle = {
    timeline: {
      refetch: async () => (typeof timelineEntries === "function" ? timelineEntries() : timelineEntries),
      append: async (item: unknown) => {
        appended.push(item);
        return { seq: appended.length, epoch: "e1" };
      },
    },
    respondToPermission: async (respondOpts: { requestId: string; response: unknown }) => {
      // Simulates the daemon delivering agent.permission_resolved before (or instead of) letting
      // our own respondToPermission call return — the real race this plugin has to survive.
      if (opts.onRespond) await opts.onRespond();
      responded.push(respondOpts);
    },
  };
  return { paseo: { agents: { ref: () => handle } }, responded, appended };
}

const withUserMessage = [{ provider: "claude-worker", item: { type: "user_message", text: "please help me pick" } }];

function mockFetch(answersFor: (body: { questions: Record<string, unknown>; state: unknown }) => Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  (globalThis as { fetch?: unknown }).fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { questions: Record<string, unknown>; state: unknown };
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ answers: answersFor(body), model: "jev-latest" }), text: async () => "" };
  };
  return calls;
}

// Confident boolean answers: low personal/destructive, high grounded (irrelevant unless personal fires).
const SAFE_BOOLEANS = { personal: { noul: 0.1 }, destructive: { noul: 0.05 }, grounded: { noul: 0.9 } };

test("confident single-select: respond, then confirmation via the resolved event logs decision + timeline", async () => {
  const { server, handlers } = makeServer();
  const cleanup = registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const event = { agent: requestedSingle.agent, request: requestedSingle.request };
  await handlers["agent.permission_requested"](event, ctx);

  assert.equal(calls.length, 1);
  assert.equal(ctx.responded.length, 1);
  const q = requestedSingle.request.input.questions[0].question;
  assert.deepEqual(ctx.responded[0], {
    requestId: requestedSingle.request.id,
    response: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } },
  });

  // Nothing is logged as "answered" yet — only the resolved event, echoing back our own answers,
  // confirms it actually took effect.
  assert.equal(readLog().filter((e) => e.kind === "decision" && e.request_id === requestedSingle.request.id).length, 0);
  assert.equal(ctx.appended.length, 0);

  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: requestedSingle.request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);

  assert.equal(ctx.appended.length, 1);
  assert.match((ctx.appended[0] as { data: { text: string } }).data.text, /Jev chose "Red" \(0\.95\)/);

  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === requestedSingle.request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "answered");
  assert.equal(decisions[0].source, "paseo");
  assert.equal(decisions[0].agent, requestedSingle.agent.id);
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);

  cleanup();
});

test("confident multi-question request: a single respond carries answers for both questions; confirmation logs both", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch((body) => {
    const pending = (body.state as { pendingQuestion: string }).pendingQuestion;
    return { pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS, __which: pending };
  });

  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request: requestedMulti.request }, ctx);

  assert.equal(ctx.responded.length, 1);
  const answers = (ctx.responded[0].response as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers;
  assert.equal(answers[q1.question], "Apple");
  assert.equal(answers[q2.question], "Summer");

  await handlers["agent.permission_resolved"]({ agent: requestedMulti.agent, requestId: requestedMulti.request.id, resolution: { behavior: "allow", updatedInput: { answers } } }, ctx);
  assert.equal(ctx.appended.length, 2);
  assert.equal(readLog().filter((e) => e.kind === "decision" && e.outcome === "answered" && e.request_id === requestedMulti.request.id).length, 2);
});

test("confident multiSelect: respond joins the selected labels with a comma", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.9 }, o3: { noul: 0.05 }, personal: { noul: 0.1 }, destructive: { noul: 0.05 } }));

  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request: requestedMultiselect.request }, ctx);

  assert.equal(ctx.responded.length, 1);
  const answers = (ctx.responded[0].response as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers;
  assert.equal(answers[requestedMultiselect.request.input.questions[0].question], "Apple, Cherry");
});

test("one low-confidence question defers the whole request — all or nothing, no respond, both questions logged", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const [q1, q2] = requestedPartial.request.input.questions;
  mockFetch((body) => {
    const pending = (body.state as { pendingQuestion: string }).pendingQuestion;
    const confident = pending === q1.question;
    return { pick: { choice: "o0", probabilities: { o0: confident ? 0.95 : 0.5, o1: confident ? 0.05 : 0.5 } }, ...SAFE_BOOLEANS };
  });

  await handlers["agent.permission_requested"]({ agent: requestedPartial.agent, request: requestedPartial.request }, ctx);

  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === requestedPartial.request.id);
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.every((d) => d.outcome === "deferred"), true);
  // The confident question is logged too (comparable rates), tagged as blocked by its sibling.
  assert.equal(decisions.find((d) => d.question === q1.question)?.reason, "sibling_blocked");
  assert.equal(decisions.find((d) => d.question === q2.question)?.reason, "low_confidence");
});

test("destructive question defers, never responds", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, personal: { noul: 0.1 }, destructive: { noul: 0.9 }, grounded: { noul: 0.9 } }));

  const request = { ...requestedSingle.request, id: "permission-destructive-test" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "destructive");
});

test("missing option descriptions defer immediately, without calling Jev", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({}));

  const request = {
    ...requestedSingle.request,
    id: "permission-missing-def-test",
    input: { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B", description: "b" }] }] },
  };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  assert.equal(calls.length, 0);
  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "missing_definition");
});

test("non-question permission kinds are ignored entirely — no Jev call, no tracking", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({}));

  const request = { ...requestedSingle.request, id: "permission-tool-kind-test", kind: "tool" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(ctx.responded.length, 0);

  // A resolved event for an id this plugin never tracked must be a silent no-op.
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: {} } } }, ctx);
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});

test("resolved before Jev returns: never responds, logs race_lost", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-race-test" };

  let releaseTimeline!: (v: unknown[]) => void;
  const stuck = new Promise<unknown[]>((resolve) => {
    releaseTimeline = resolve;
  });
  const ctxStuck = makeContext(() => stuck);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  // map.set happens synchronously before any await, so the resolved handler below already
  // sees this request as tracked even though fetchState() is still stuck awaiting the timeline.
  const reqPromise = handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctxStuck);
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: {} } } }, ctxStuck);
  releaseTimeline(withUserMessage);
  await reqPromise;

  assert.equal(ctxStuck.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "race_lost");
});

test("duplicate delivery (two installed plugin copies) makes exactly one Jev call", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const request = { ...requestedSingle.request, id: "permission-dup-test" };
  const event = { agent: requestedSingle.agent, request };
  const p1 = handlers["agent.permission_requested"](event, ctx);
  const p2 = handlers["agent.permission_requested"](event, ctx);
  await Promise.all([p1, p2]);

  assert.equal(calls.length, 1);
  assert.equal(ctx.responded.length, 1);
});

test("human-resolved question (Jev never answered) logs user_choice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-human-test" };

  delete process.env.TYPESAFE_API_KEY; // forces an immediate "no_key" defer, no Jev call
  try {
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  } finally {
    process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  }
  assert.equal(ctx.responded.length, 0);

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Blue" } } } }, ctx);

  const choices = readLog().filter((e) => e.kind === "user_choice");
  assert.equal(choices.length, 1);
  assert.equal(choices[0].question, q);
  assert.deepEqual(choices[0].chosen, ["Blue"]);
  assert.deepEqual(choices[0].options, ["Red", "Blue"]);
  assert.equal(choices[0].cwd, requestedSingle.agent.cwd);
  assert.equal(choices[0].kind_of_answer, "option");
});

test("multiSelect user_choice matches against known option labels instead of blindly splitting on every comma", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedMultiselect.request, id: "permission-human-multiselect-test" };

  delete process.env.TYPESAFE_API_KEY;
  try {
    await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request }, ctx);
  } finally {
    process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  }

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedMultiselect.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Apple, Cherry" } } } }, ctx);

  const choices = readLog().filter((e) => e.kind === "user_choice");
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].chosen, ["Apple", "Cherry"]);
  assert.equal(choices[0].kind_of_answer, "option");
});

test("resolved (with Jev's own answers) arrives WHILE respondToPermission is still pending: confirmed once, never logged as user_choice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const request = { ...requestedSingle.request, id: "permission-inflight-jev-test" };
  const q = request.input.questions[0].question;
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const ctx = makeContext(withUserMessage, {
    onRespond: async () => {
      // The daemon resolves (and tells us) before our own respondToPermission call returns.
      await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);
    },
  });

  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "answered");
  assert.equal(ctx.appended.length, 1);
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});

test("resolved (with the human's DIFFERENT answer) arrives WHILE respondToPermission is pending: our stale respond is a no-op, human's pick is logged as user_choice, no false answered/timeline", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const request = { ...requestedSingle.request, id: "permission-inflight-human-test" };
  const q = request.input.questions[0].question;
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS })); // Jev would pick Red

  const ctx = makeContext(withUserMessage, {
    onRespond: async () => {
      // The human already answered "Blue" before our (stale, ultimately no-op) respond lands.
      await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Blue" } } } }, ctx);
    },
  });

  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  assert.equal(readLog().filter((e) => e.kind === "decision" && e.outcome === "answered" && e.request_id === request.id).length, 0);
  assert.equal(ctx.appended.length, 0);

  // Jev did attempt an answer here (unlike a plain deferral) and lost the race — that's a distinct
  // stat from the user_choice provenance, logged alongside it.
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "race_lost");

  const choices = readLog().filter((e) => e.kind === "user_choice");
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].chosen, ["Blue"]);
});

test("empty multiSelect selection (Jev applies no option) defers the whole request instead of sending an empty answer", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ o0: { noul: 0.05 }, o1: { noul: 0.05 }, o2: { noul: 0.05 }, o3: { noul: 0.05 }, personal: { noul: 0.1 }, destructive: { noul: 0.05 } }));

  const request = { ...requestedMultiselect.request, id: "permission-empty-multiselect-test" };
  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request }, ctx);

  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "empty_selection");
});

test("an unconfirmed answer (resolved event never arrives) is swept as unconfirmed after its TTL, and stops tracking", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-unconfirmed-test" };
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  process.env.ASK_JEV_PASEO_TTL_MS = "10";
  try {
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
    assert.equal(ctx.responded.length, 1);
    await new Promise((r) => setTimeout(r, 20));

    // Any subsequent permission_requested triggers the lazy sweep; a "tool" kind is ignored for
    // everything except the sweep itself.
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request: { ...request, id: "permission-unrelated-sweep-trigger", kind: "tool" } }, ctx);
  } finally {
    delete process.env.ASK_JEV_PASEO_TTL_MS;
  }

  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "unconfirmed");

  // The entry was evicted — a resolved event arriving even later must be a silent no-op now.
  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});

test("a deferred (never-answered) request survives the short TTL and a sweep — a late human answer still logs user_choice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-deferred-survives-sweep-test" };

  delete process.env.TYPESAFE_API_KEY; // forces an immediate "no_key" defer — tracked, never answered
  process.env.ASK_JEV_PASEO_TTL_MS = "10"; // the short (jevAnswers) TTL — must NOT apply to this entry
  try {
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
    await new Promise((r) => setTimeout(r, 20));

    // Trigger a sweep well past the short TTL; a deferred entry must not be evicted by it.
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request: { ...request, id: "permission-unrelated-sweep-trigger-2", kind: "tool" } }, ctx);
  } finally {
    process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
    delete process.env.ASK_JEV_PASEO_TTL_MS;
  }

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Blue" } } } }, ctx);

  const choices = readLog().filter((e) => e.kind === "user_choice" && e.question === q);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].chosen, ["Blue"]);
  // No spurious race_lost/unconfirmed for a request Jev never actually answered.
  assert.equal(readLog().filter((e) => e.kind === "decision" && e.request_id === request.id && e.outcome !== "deferred").length, 0);
});

test("respondToPermission throwing after the answer was sent: no per-question error, resolved event still confirms it landed", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const request = { ...requestedSingle.request, id: "permission-respond-throws-test" };
  const q = request.input.questions[0].question;
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));
  const ctx = makeContext(withUserMessage, {
    onRespond: () => {
      throw new Error("network blip after the daemon actually received it");
    },
  });

  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  // No per-question "error" — we don't know yet whether it landed.
  assert.equal(readLog().filter((e) => e.kind === "decision" && e.request_id === request.id).length, 0);
  const diagnostics = readLog().filter((e) => e.kind === "diagnostic" && e.request_id === request.id);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].outcome, "error");

  // It turns out it DID land — the resolved event echoes our own answer back.
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "answered");
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});

test("Jev-resolved question never logs user_choice, even when Paseo echoes the resolution back", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const request = { ...requestedSingle.request, id: "permission-jev-resolved-test" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  assert.equal(ctx.responded.length, 1);

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);

  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});
