import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { computeStats, filterRepo, filterSince, normalizeRepo, parseEvents, recentDecisions, sinceMsFromSpec } from "../shared/stats.mjs";
import type { JevStats } from "../shared/contracts";
import { jevDecisionRpc, jevStatsRpc } from "../shared/contracts";

const RECENT_LIMIT = 200;

interface GateSummary {
  total: number;
  positive: number;
  by_outcome: Record<string, number>;
}

interface StatsSummary {
  calls: { total: number; ok: number; error: number; avg_latency_ms: number; p95_latency_ms: number };
  decisions: {
    total: number;
    by_outcome: Record<string, number>;
    by_gate: Record<string, GateSummary>;
    positive_pct: number;
    fallback_pct: number;
  };
  user_overrides: number;
}

interface LogEvent {
  ts: string;
  kind: string;
  gate?: string;
  outcome?: string;
  question?: string;
  label?: string;
  confidence?: number;
  reason?: string;
  repo?: string;
  agent?: string;
}

let cache: { path: string; mtimeMs: number; size: number; events: LogEvent[] } | null = null;

/** Re-parses only when mtime/size change — the 2s panel poll must not re-read an unchanged file. */
function loadEvents(path: string): LogEvent[] | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.events;
  }
  const events = parseEvents(readFileSync(path, "utf8")) as LogEvent[];
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, events };
  return events;
}

function logPath(): string {
  return process.env.ASK_JEV_LOG_FILE || process.env.JEV_LOG_FILE || join(homedir(), ".claude", "ask-jev.log");
}

// ponytail: remote cached per cwd for the server's lifetime — `paseo plugin reload ask-jev` after changing a remote.
const remotes = new Map<string, string | null>();

function remoteOf(cwd: string): string | null {
  let url = remotes.get(cwd);
  if (url === undefined) {
    try {
      url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null;
    } catch {
      url = null;
    }
    remotes.set(cwd, url);
  }
  return url;
}

function emptyStats(path: string, scope: string): JevStats {
  return {
    logPath: path,
    scope,
    hasLog: false,
    calls: { total: 0, ok: 0, error: 0, avg_latency_ms: 0, p95_latency_ms: 0 },
    decisions: { total: 0, by_outcome: {}, by_gate: {}, positive_pct: 0, fallback_pct: 0 },
    user_overrides: 0,
    recent: [],
  };
}

/** Scoped to the workspace's git remote; no cwd (workspace not resolved) → every repo. */
export function getStats({ since, outcome, gate, cwd }: RpcInput<typeof jevStatsRpc>): JevStats {
  const path = logPath();
  const remote = cwd === undefined ? undefined : remoteOf(cwd);
  const scope = cwd === undefined ? "all repos" : (normalizeRepo(remote) ?? "no git remote");
  const allEvents = loadEvents(path);
  if (!allEvents) return emptyStats(path, scope);

  let events = filterSince(allEvents, sinceMsFromSpec(since));
  if (cwd !== undefined) events = filterRepo(events, remote);
  const summary = computeStats(events) as StatsSummary;

  // Filter by gate/outcome before capping, so a rare one isn't crowded out by the 200-row cap.
  let recent = recentDecisions(events, events.length) as LogEvent[];
  if (gate !== "all") recent = recent.filter((d) => d.gate === gate);
  if (outcome !== "all") recent = recent.filter((d) => d.outcome === outcome);
  recent = recent.slice(0, RECENT_LIMIT);

  return {
    logPath: path,
    scope,
    hasLog: true,
    calls: summary.calls,
    decisions: summary.decisions,
    user_overrides: summary.user_overrides,
    recent: recent.map((d) => ({
      ts: d.ts,
      gate: d.gate,
      outcome: d.outcome ?? "",
      question: d.question ?? "",
      label: d.label,
      confidence: d.confidence,
      reason: d.reason,
      repo: d.repo,
      agent: d.agent,
    })),
  };
}

/** Full raw log line for a row, keyed by ts+gate — reads the same cache getStats() populates. */
export function getDecision({ ts, gate }: RpcInput<typeof jevDecisionRpc>): Record<string, unknown> | null {
  const events = loadEvents(logPath());
  if (!events) return null;
  const match = events.find((e) => e.ts === ts && (e.gate ?? "") === (gate ?? ""));
  return (match as unknown as Record<string, unknown>) ?? null;
}
