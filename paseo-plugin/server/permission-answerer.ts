import { randomUUID } from "node:crypto";
import type { PluginServerContext, PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { apiKey, askJev, logEvent } from "./vendor/jev.mjs";
import { buildState, hasContext } from "./vendor/context.mjs";
import { autonomy } from "./vendor/gate.mjs";
import { env } from "./vendor/env.mjs";
import { buildPickQuestions, buildMultiQuestions, interpretPick, interpretMulti, pickCriteria } from "./vendor/answer-policy.mjs";
import { remoteOf } from "./log";
import { ASK_JEV_TIMELINE_KIND, ASK_JEV_TIMELINE_VERSION } from "../shared/contracts";

const THRESHOLD = Number(env("ASK_THRESHOLD", "0.8"));
// ponytail: swept lazily whenever a request comes in or resolves; a live daemon gets plenty of
// those. An entry with jevAnswers that's still unswept-but-unresolved past this age gets logged
// unconfirmed and dropped — a bounded wait for confirmation, not an unbounded leak. Read fresh on
// every sweep (not cached at module load) so ASK_JEV_PASEO_TTL_MS can be set after import in tests.
function trackedTtlMs(): number {
  return Number(env("PASEO_TTL_MS", String(5 * 60_000)));
}

interface PaseoOption {
  label: string;
  description?: string;
}

interface PaseoQuestion {
  question: string;
  header?: string;
  options?: PaseoOption[];
  multiSelect?: boolean;
}

type PickResult = { outcome: string; label?: string; confidence?: number; reason?: string };

interface TrackedRequest {
  owner: string;
  agentId: string;
  requestId: string;
  cwd: string;
  repo?: string;
  questions: PaseoQuestion[];
  createdAt: number;
  resolved: boolean;
  waiters: Array<() => void>;
  /** The exact answers map we're about to send (or already sent) — set BEFORE respondToPermission
   * is called, so the resolved handler can tell "our answer took effect" from "it didn't" purely by
   * comparing values, regardless of whether resolved arrives before or after respond() returns. */
  jevAnswers?: Record<string, string>;
  jevResults?: PickResult[];
  /** respondToPermission threw — we genuinely don't know whether the daemon got it. Treated like a
   * deferred entry (long TTL, no proactive race_lost/unconfirmed) unless the resolved event later
   * shows it landed after all (resolvedAnswers matches jevAnswers → still "answered"). */
  respondFailed?: boolean;
}

/** True only when we believe the answer is genuinely in flight to the daemon — not when our own
 * send already failed client-side (respondFailed), which has nothing to confirm or lose a race on. */
function awaitingConfirmation(tracked: Pick<TrackedRequest, "jevAnswers" | "respondFailed">): boolean {
  return Boolean(tracked.jevAnswers) && !tracked.respondFailed;
}

const INFLIGHT_KEY = Symbol.for("ask-jev.paseo.inflight");

function inflightMap(): Map<string, TrackedRequest> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[INFLIGHT_KEY] instanceof Map)) g[INFLIGHT_KEY] = new Map<string, TrackedRequest>();
  return g[INFLIGHT_KEY] as Map<string, TrackedRequest>;
}

// A deferred request (Jev never answered — no jevAnswers) has no bounded confirmation to wait
// for; it just waits for whenever the human actually answers. It only needs a long safety cap so
// an agent that's archived without ever resolving doesn't leak the entry forever.
const DEFERRED_TTL_MS = 24 * 60 * 60_000;

/** Evicts entries this sweep call notices are stale, logging unconfirmed for ones we actually
 * answered but never heard back on. Deferred entries (never answered) are left alone until they
 * resolve or hit the long safety cap — sweeping them on the short TTL would drop a request the
 * user hasn't gotten to yet, silently losing its eventual user_choice. */
function sweepStale(map: Map<string, TrackedRequest>) {
  const now = Date.now();
  const ttl = trackedTtlMs();
  for (const [key, tracked] of map) {
    const age = now - tracked.createdAt;
    if (awaitingConfirmation(tracked)) {
      if (age < ttl) continue;
      logPerQuestion(tracked.questions, metaOf(tracked), "unconfirmed", () => undefined);
      map.delete(key);
    } else if (age >= DEFERRED_TTL_MS) {
      // Safety cap only — a plain deferral already logged "deferred", and a respondFailed entry
      // already logged its diagnostic, when we decided/found out we hadn't answered.
      map.delete(key);
    }
  }
}

function metaOf(tracked: Pick<TrackedRequest, "agentId" | "repo" | "requestId">) {
  return { agent: tracked.agentId, ...(tracked.repo ? { repo: tracked.repo } : {}), request_id: tracked.requestId };
}

function logPerQuestion(questions: PaseoQuestion[], meta: Record<string, unknown>, outcome: string, reasonFor: (q: PaseoQuestion, i: number) => string | undefined) {
  questions.forEach((q, i) => {
    const reason = reasonFor(q, i);
    logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome, question: q.question, ...(reason ? { reason } : {}), ...meta });
  });
}

/** Only user/assistant text, in the row shape lib/context.mjs's transcriptRows expects. */
function timelineToRows(entries: unknown[]): Array<{ type: string; message: { content: string } }> {
  const rows: Array<{ type: string; message: { content: string } }> = [];
  for (const entry of entries) {
    const item = (entry as { item?: { type?: string; text?: string } } | undefined)?.item;
    if (!item || typeof item.text !== "string") continue;
    if (item.type === "user_message") rows.push({ type: "user", message: { content: item.text } });
    else if (item.type === "assistant_message") rows.push({ type: "assistant", message: { content: item.text } });
  }
  return rows;
}

/** Builds the same state shape the hook uses, from the Paseo timeline instead of a Claude Code
 * transcript file — buildState's transcriptRows takes the rows directly, no temp file needed. */
async function fetchState(paseo: PaseoApi, agentId: string, cwd: string): Promise<{ state: unknown; sizes: Record<string, number> }> {
  let entries: unknown[] = [];
  try {
    const payload = await paseo.agents.ref(agentId).timeline.refetch();
    entries = Array.isArray(payload) ? payload : ((payload as { entries?: unknown[] })?.entries ?? []);
  } catch {
    entries = [];
  }
  const options = { transcriptRows: timelineToRows(entries), transcriptPath: undefined, cwd, sessionId: undefined, action: undefined, extra: undefined };
  const built = buildState(options as unknown as Parameters<typeof buildState>[0]);
  return built as { state: unknown; sizes: Record<string, number> };
}

/** Every option needs a definition Jev can score — same requirement as hooks/ask-jev.mjs. */
function isScorable(q: PaseoQuestion): boolean {
  const opts = q.options ?? [];
  return opts.length >= 2 && opts.every((o) => Boolean(o.description?.trim()));
}

async function decideOne(key: string, q: PaseoQuestion, context: unknown, sizes: Record<string, number>, meta: Record<string, unknown>): Promise<PickResult> {
  const mode = autonomy();
  const options = q.options ?? [];
  if (q.multiSelect) {
    const answers = await askJev(
      key,
      { conversationContext: context, pendingQuestion: q.question },
      buildMultiQuestions(q.question, options, { autonomy: mode }),
      "paseo",
      8000,
      sizes,
      meta,
    );
    return interpretMulti(answers, options, { autonomy: mode, threshold: THRESHOLD });
  }
  const answers = await askJev(
    key,
    { conversationContext: context, pendingQuestion: q.question, answerOptions: pickCriteria(options) },
    buildPickQuestions(options, { autonomy: mode }),
    "paseo",
    8000,
    sizes,
    meta,
  );
  return interpretPick(answers, options, { autonomy: mode, threshold: THRESHOLD });
}

/** A multiSelect that resolved to zero applying options isn't a usable answer — treat it as a blocker. */
function isEmptyMultiSelect(q: PaseoQuestion, r: PickResult): boolean {
  return Boolean(q.multiSelect) && r.outcome === "answered" && r.label === "none";
}

function blockerReason(q: PaseoQuestion, r: PickResult): string {
  if (r.outcome !== "answered") return r.outcome;
  // This question itself was confident — a sibling in the same all-or-nothing request blocked it.
  return isEmptyMultiSelect(q, r) ? "empty_selection" : "sibling_blocked";
}

/** Splits on the daemon's own join (", "), unless the whole raw string already matches a single
 * known label as-is (covers a label that itself contains a comma). Unmatched parts (a free-typed
 * "Other" addition alongside real picks) are kept, not dropped — kind_of_answer downstream reflects
 * whether every part matched a known label. */
function parseMultiSelectAnswer(raw: string, options: PaseoOption[]): string[] {
  const labels = new Set(options.map((o) => o.label));
  if (labels.has(raw)) return [raw];
  return raw.split(", ");
}

function sameAnswers(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

export function registerPermissionAnswerer(server: PluginServerContext): () => void {
  const owner = randomUUID();

  const offRequested = server.on("agent.permission_requested", async (event, context) => {
    const agent = event.agent as PluginHookAgent;
    const request = event.request as AgentPermissionRequest;
    const map = inflightMap();
    sweepStale(map);
    if (request.kind !== "question") return;

    const key = `${agent.id}:${request.id}`;
    if (map.has(key)) return; // duplicate delivery — another copy (or an earlier call) already owns this

    const questions = ((request.input as { questions?: PaseoQuestion[] } | undefined)?.questions ?? []) as PaseoQuestion[];
    const repo = remoteOf(agent.cwd) ?? undefined;
    const tracked: TrackedRequest = {
      owner,
      agentId: agent.id,
      requestId: request.id,
      cwd: agent.cwd,
      repo,
      questions,
      createdAt: Date.now(),
      resolved: false,
      waiters: [],
    };
    map.set(key, tracked);

    const meta = metaOf(tracked);
    const deferAll = (reason: string) => logPerQuestion(questions, meta, "deferred", () => reason);

    try {
      if (questions.length === 0 || !questions.every(isScorable)) return deferAll("missing_definition");

      const key2 = apiKey();
      if (!key2) return deferAll("no_key");

      const { state, sizes } = await fetchState(context.paseo, agent.id, agent.cwd);
      if (!hasContext(state)) return deferAll("no_context");

      const waitForResolve = new Promise<"resolved">((resolve) => tracked.waiters.push(() => resolve("resolved")));
      const work = Promise.all(questions.map((q) => decideOne(key2, q, state, sizes, meta).catch((): PickResult => ({ outcome: "error" }))));
      const winner = await Promise.race([work.then((results) => ({ done: true as const, results })), waitForResolve.then(() => ({ done: false as const }))]);

      if (!winner.done || tracked.resolved) return logPerQuestion(questions, meta, "race_lost", () => undefined);

      const results = winner.results;
      if (results.some((r, i) => r.outcome !== "answered" || isEmptyMultiSelect(questions[i], r))) {
        return logPerQuestion(questions, meta, "deferred", (q, i) => blockerReason(q, results[i]));
      }

      if (tracked.resolved) return logPerQuestion(questions, meta, "race_lost", () => undefined); // recheck right before responding

      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        answers[q.question] = results[i].label ?? "";
      });

      // Snapshot BEFORE the network call: the resolved handler compares against this, not against
      // a flag set after respond() returns, so it classifies correctly no matter which arrives first.
      tracked.jevAnswers = answers;
      tracked.jevResults = results;

      await context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow", updatedInput: { answers } } });
      // Do NOT log "answered" or append the timeline here — respondToPermission succeeding is not
      // proof it took effect (a stale respond to an already-resolved request also "succeeds"). The
      // resolved handler is the single source of truth: it confirms by comparing resolution.answers
      // to tracked.jevAnswers, whenever that event actually arrives (sweepStale() logs "unconfirmed"
      // if it never does).
    } catch {
      if (tracked.jevAnswers) {
        // respondToPermission threw — maybe before, maybe after actually reaching the daemon; we
        // can't tell. Mark it so sweepStale/the resolved handler treat this like a deferral (long
        // TTL, no proactive race_lost/unconfirmed) rather than assuming either outcome. Don't log a
        // per-question "error" that a later "answered" (if it turns out to have landed) would then
        // contradict; just note it happened.
        tracked.respondFailed = true;
        logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "error", ...meta });
      } else {
        logPerQuestion(questions, meta, "error", () => undefined);
      }
    }
  });

  const offResolved = server.on("agent.permission_resolved", async (event, context) => {
    try {
      const agent = event.agent as PluginHookAgent;
      const { requestId, resolution } = event as { requestId: string; resolution: AgentPermissionResponse };
      const map = inflightMap();
      sweepStale(map);
      const key = `${agent.id}:${requestId}`;
      const tracked = map.get(key);
      if (!tracked) return; // not a question request this plugin tracked

      tracked.resolved = true;
      tracked.waiters.forEach((w) => w());
      map.delete(key);

      if (resolution.behavior !== "allow") return; // nothing chosen to attribute either way

      const resolvedAnswers = ((resolution as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers ?? {}) as Record<string, string>;
      const meta = metaOf(tracked);

      if (sameAnswers(tracked.jevAnswers, resolvedAnswers) && tracked.jevResults) {
        const results = tracked.jevResults;
        tracked.questions.forEach((q, i) => {
          const r = results[i];
          logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome: "answered", question: q.question, label: r.label, confidence: r.confidence, ...meta });
        });
        try {
          const timeline = context.paseo.agents.ref(agent.id).timeline;
          for (const [i, q] of tracked.questions.entries()) {
            const r = results[i];
            await timeline.append({
              type: "plugin",
              id: randomUUID(),
              kind: ASK_JEV_TIMELINE_KIND,
              version: ASK_JEV_TIMELINE_VERSION,
              data: { text: `Jev chose "${r.label}" (${(r.confidence ?? 0).toFixed(2)})`, question: q.question, label: r.label ?? "", confidence: r.confidence ?? 0 },
            });
          }
        } catch {
          /* timeline reporting is best-effort — the confirmed decision is already logged */
        }
        return;
      }

      // Three ways to land here: Jev never answered (deferred to the user — "deferred" was already
      // logged, nothing more to add); Jev answered and respondToPermission genuinely raced a stale
      // no-op against an already-resolved request (a real race lost, worth its own stat); or
      // respondToPermission itself threw and this mismatch just confirms it never reached the
      // daemon (already covered by the diagnostic logged at throw time — not a race, so no
      // race_lost here).
      if (awaitingConfirmation(tracked)) {
        logPerQuestion(tracked.questions, meta, "race_lost", () => undefined);
      }

      for (const q of tracked.questions) {
        const chosenRaw = resolvedAnswers[q.question];
        if (chosenRaw === undefined) continue;
        const chosen = q.multiSelect ? parseMultiSelectAnswer(chosenRaw, q.options ?? []) : [chosenRaw];
        const labels = new Set((q.options ?? []).map((o) => o.label));
        const kindOfAnswer = chosen.every((c) => labels.has(c)) ? "option" : "free_text";
        logEvent({
          kind: "user_choice",
          source: "paseo",
          agent: agent.id,
          cwd: tracked.cwd,
          ...(tracked.repo ? { repo: tracked.repo } : {}),
          question: q.question,
          options: (q.options ?? []).map((o) => o.label),
          chosen,
          kind_of_answer: kindOfAnswer,
        });
      }
    } catch {
      logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "error" });
    }
  });

  return () => {
    offRequested();
    offResolved();
    // Unstick any in-flight Jev work THIS instance started so it never calls respondToPermission
    // after unload — it'll just log race_lost and leave the request for the user. Entries owned by
    // the other installed copy (if any) are left alone; they're that copy's responsibility. Deleted
    // (not just marked resolved) so they don't linger in the shared map across reloads.
    const map = inflightMap();
    for (const [key, tracked] of map) {
      if (tracked.owner !== owner) continue;
      tracked.resolved = true;
      tracked.waiters.forEach((w) => w());
      map.delete(key);
    }
  };
}
