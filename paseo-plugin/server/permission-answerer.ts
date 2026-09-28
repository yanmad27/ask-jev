import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext, PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { apiKey, askJev, logEvent } from "../shared/jev.mjs";
import { buildState, hasContext } from "../shared/context.mjs";
import { autonomy } from "../shared/gate.mjs";
import { env } from "../shared/env.mjs";
import { buildPickQuestions, buildMultiQuestions, interpretPick, interpretMulti, pickCriteria } from "../shared/answer-policy.mjs";

const THRESHOLD = Number(env("ASK_THRESHOLD", "0.8"));

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
  questions: PaseoQuestion[];
  answeredByJev: boolean;
  resolved: boolean;
  waiters: Array<() => void>;
}

const INFLIGHT_KEY = Symbol.for("ask-jev.paseo.inflight");

function inflightMap(): Map<string, TrackedRequest> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[INFLIGHT_KEY] instanceof Map)) g[INFLIGHT_KEY] = new Map<string, TrackedRequest>();
  return g[INFLIGHT_KEY] as Map<string, TrackedRequest>;
}

/** Mirrors server/log.ts's remoteOf — best-effort, no caching (one-shot per request here). */
function repoOf(cwd: string): string | undefined {
  try {
    return (
      execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Only user/assistant text, in the shape lib/context.mjs's readRows() expects from a real transcript file. */
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

/**
 * Builds the same state shape the hook uses, from the Paseo timeline instead of a Claude Code
 * transcript file — writes a synthetic transcript so the vendored buildState() needs no changes.
 */
async function fetchState(paseo: PaseoApi, agentId: string, cwd: string): Promise<{ state: unknown; sizes: Record<string, number> }> {
  let entries: unknown[] = [];
  try {
    const payload = await paseo.agents.ref(agentId).timeline.refetch();
    entries = Array.isArray(payload) ? payload : ((payload as { entries?: unknown[] })?.entries ?? []);
  } catch {
    entries = [];
  }
  const rows = timelineToRows(entries);
  const tmpFile = join(tmpdir(), `ask-jev-paseo-${randomUUID()}.jsonl`);
  writeFileSync(tmpFile, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  try {
    const built = buildState({ transcriptPath: tmpFile, cwd, sessionId: undefined, action: undefined, extra: undefined });
    return built as { state: unknown; sizes: Record<string, number> };
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Every option needs a definition Jev can score — same requirement as hooks/ask-jev.mjs. */
function isScorable(q: PaseoQuestion): boolean {
  const opts = q.options ?? [];
  return opts.length >= 2 && opts.every((o) => Boolean(o.description?.trim()));
}

async function decideOne(key: string, q: PaseoQuestion, context: unknown, sizes: Record<string, number>): Promise<PickResult> {
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
  );
  return interpretPick(answers, options, { autonomy: mode, threshold: THRESHOLD });
}

function answerValue(q: PaseoQuestion, result: PickResult): string {
  const label = result.label ?? "";
  if (!q.multiSelect) return label;
  return label === "none" ? "" : label;
}

export function registerPermissionAnswerer(server: PluginServerContext): () => void {
  const offRequested = server.on("agent.permission_requested", async (event, context) => {
    const agent = event.agent as PluginHookAgent;
    const request = event.request as AgentPermissionRequest;
    if (request.kind !== "question") return;

    const map = inflightMap();
    const key = `${agent.id}:${request.id}`;
    if (map.has(key)) return; // duplicate delivery — another copy (or an earlier call) already owns this

    const questions = ((request.input as { questions?: PaseoQuestion[] } | undefined)?.questions ?? []) as PaseoQuestion[];
    const tracked: TrackedRequest = { questions, answeredByJev: false, resolved: false, waiters: [] };
    map.set(key, tracked);

    const repo = repoOf(agent.cwd);
    const meta = { agent: agent.id, ...(repo ? { repo } : {}), request_id: request.id };
    const deferred = (reason: string) => logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome: "deferred", reason, ...meta });

    try {
      if (questions.length === 0 || !questions.every(isScorable)) return deferred("missing_definition");

      const key2 = apiKey();
      if (!key2) return deferred("no_key");

      const { state, sizes } = await fetchState(context.paseo, agent.id, agent.cwd);
      if (!hasContext(state)) return deferred("no_context");

      const waitForResolve = new Promise<"resolved">((resolve) => tracked.waiters.push(() => resolve("resolved")));
      const work = Promise.all(questions.map((q) => decideOne(key2, q, state, sizes).catch((): PickResult => ({ outcome: "error" }))));
      const winner = await Promise.race([work.then((results) => ({ done: true as const, results })), waitForResolve.then(() => ({ done: false as const }))]);

      const raceLost = () => logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome: "race_lost", ...meta });
      if (!winner.done || tracked.resolved) return raceLost();

      const results = winner.results;
      const blocker = results.find((r) => r.outcome !== "answered");
      if (blocker) return deferred(blocker.outcome);

      if (tracked.resolved) return raceLost(); // recheck right before responding

      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        answers[q.question] = answerValue(q, results[i]);
      });

      await context.paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow", updatedInput: { answers } } });
      tracked.answeredByJev = true;

      questions.forEach((q, i) => {
        const r = results[i];
        logEvent({ kind: "decision", source: "paseo", gate: "ask", outcome: "answered", question: q.question, label: r.label, confidence: r.confidence, ...meta });
      });

      try {
        const timeline = context.paseo.agents.ref(agent.id).timeline;
        for (const [i, q] of questions.entries()) {
          const r = results[i];
          await timeline.append({
            type: "plugin",
            id: randomUUID(),
            kind: "ask-jev.decision",
            version: 1,
            data: { text: `Jev chose "${r.label}" (${(r.confidence ?? 0).toFixed(2)})`, question: q.question, label: r.label ?? "", confidence: r.confidence ?? 0 },
          });
        }
      } catch {
        /* timeline reporting is best-effort — the answer itself already landed */
      }
    } catch {
      logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "error", ...meta });
    }
  });

  const offResolved = server.on("agent.permission_resolved", async (event) => {
    const agent = event.agent as PluginHookAgent;
    const { requestId, resolution } = event as { requestId: string; resolution: AgentPermissionResponse };
    const map = inflightMap();
    const key = `${agent.id}:${requestId}`;
    const tracked = map.get(key);
    if (!tracked) return; // not a question request this plugin tracked

    tracked.resolved = true;
    tracked.waiters.forEach((w) => w());

    if (!tracked.answeredByJev && resolution.behavior === "allow") {
      const answers = ((resolution as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers ?? {}) as Record<string, string>;
      for (const q of tracked.questions) {
        const chosenRaw = answers[q.question];
        if (chosenRaw === undefined) continue;
        const chosen = q.multiSelect ? chosenRaw.split(",").map((s) => s.trim()).filter(Boolean) : [chosenRaw];
        logEvent({ kind: "user_choice", source: "paseo", agent: agent.id, question: q.question, options: (q.options ?? []).map((o) => o.label), chosen });
      }
    }
    map.delete(key);
  });

  return () => {
    offRequested();
    offResolved();
    // Unstick any in-flight Jev work this process started so it never calls respondToPermission
    // after unload — it will just log race_lost and leave the request for the user, same as today.
    for (const tracked of inflightMap().values()) {
      tracked.resolved = true;
      tracked.waiters.forEach((w) => w());
    }
  };
}
