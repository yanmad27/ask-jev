/** Aggregation trên các dòng JSONL của ask-jev.log. Không dùng fs — nhận text/events thô,
 * để dùng chung được cho cả CLI (đọc file) lẫn plugin server (đọc file khác, có thể watch). */

export function parseEvents(raw) {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

export function sinceMsFromSpec(spec) {
  const m = /^(\d+)(h|d)$/.exec(spec ?? "");
  if (!m) return 0;
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

export function filterSince(events, sinceMs) {
  return sinceMs ? events.filter((e) => Date.now() - new Date(e.ts).getTime() <= sinceMs) : events;
}

/** Cùng một repo có thể được log dạng ssh, https hay kèm user@ — quy về "host/owner/repo" để so khớp. */
export function normalizeRepo(url) {
  const m = String(url ?? "").trim().replace(/\/+$/, "").replace(/\.git$/, "")
    .match(/^(?:[a-z][a-z+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Chỉ giữ event của repo `url`; url rỗng/null → chỉ event không có repo (thư mục không có git remote). */
export function filterRepo(events, url) {
  const want = normalizeRepo(url);
  return events.filter((e) => normalizeRepo(e.repo) === want);
}

/** Outcome nào đếm là "Jev quyết được" cho từng gate — điều chỉnh nếu đổi tên outcome. */
export const POSITIVE = {
  ask: ["answered", "advised"],
  permission: ["allow"],
  stop: ["ok"],
  bash: ["success"],
  prompt: ["clear"],
};

const SOURCES = ["hook", "paseo", "cli"];
const DEFAULT_THRESHOLD = 0.8;

const isAdvisory = (d) => d.gate === "ask" && d.mode === "advisory";
const isHumanAnswer = (e) => e.kind === "outcome" || e.kind === "user_choice";
const sourceOf = (e) => (SOURCES.includes(e.source) ? e.source : e.gate === "cli" ? "cli" : "uncategorized");

/** CLI không có funnel answered/fallback: coi là "acted" khi confidence >= threshold, "fallback" (agent tự chọn) khi dưới. */
function cliActed(d) {
  if (typeof d.confidence !== "number") return null;
  return d.confidence >= (typeof d.threshold === "number" ? d.threshold : DEFAULT_THRESHOLD);
}

function isPositive(d) {
  if (d.gate === "cli") return cliActed(d) === true;
  return (POSITIVE[d.gate] ?? []).includes(d.outcome);
}

/** "Fell back to user": câu hỏi/permission thực sự quay lại tay người; advice_unavailable = Jev không đưa được lời khuyên. */
function isFallback(d) {
  if (d.gate === "ask") return !["answered", "advised"].includes(d.outcome);
  if (d.gate === "permission") return d.outcome === "ask";
  if (d.gate === "cli") return cliActed(d) === false;
  return false;
}

const bump = (obj, key) => {
  obj[key] = (obj[key] ?? 0) + 1;
};
const ratio = (n, total) => (total ? n / total : 0);
const pct = (n, total) => ratio(n, total) * 100;

export function computeStats(events) {
  const calls = events.filter((e) => e.kind === "call");
  const decisions = events.filter((e) => e.kind === "decision");
  const latencies = calls.map((c) => c.latency_ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const callSources = Object.fromEntries(SOURCES.map((s) => [s, { calls: 0, errors: 0, error_rate: 0 }]));
  /** @type {Record<string, number>} */
  const byErrorClass = {};
  for (const c of calls) {
    const src = sourceOf(c);
    callSources[src] ??= { calls: 0, errors: 0, error_rate: 0 };
    callSources[src].calls++;
    if (c.status === "error") {
      callSources[src].errors++;
      bump(byErrorClass, c.error_class ?? "uncategorized");
    }
  }
  for (const v of Object.values(callSources)) v.error_rate = ratio(v.errors, v.calls);
  const callErrors = calls.filter((c) => c.status === "error").length;

  /** @type {Record<string, number>} */
  const byOutcome = {};
  /** @type {Record<string, { total: number, positive: number, by_outcome: Record<string, number> }>} */
  const byGate = {};
  const decisionSources = Object.fromEntries(SOURCES.map((s) => [s, { decisions: 0 }]));
  /** @type {Record<string, number>} */
  const unavailableByReason = {};
  const advisory = { questions: 0, advised: 0, advice_unavailable: 0, unavailable_by_reason: unavailableByReason, strong: 0, weak: 0 };
  /** @type {Record<string, number>} */
  const legacyByOutcome = {};
  const legacyAutonomous = { total: 0, by_outcome: legacyByOutcome };
  let total = 0;
  let positive = 0;
  let fallback = 0;
  for (const d of decisions) {
    const g = d.gate ?? "uncategorized";
    byGate[g] ??= { total: 0, positive: 0, by_outcome: {} };
    byGate[g].total++;
    bump(byGate[g].by_outcome, d.outcome);
    const pos = isPositive(d);
    if (pos) byGate[g].positive++;

    total++;
    bump(byOutcome, d.outcome);
    if (pos) positive++;
    if (isFallback(d)) fallback++;
    const src = sourceOf(d);
    decisionSources[src] ??= { decisions: 0 };
    decisionSources[src].decisions++;

    if (isAdvisory(d)) {
      advisory.questions++;
      if (d.outcome === "advised") {
        advisory.advised++;
        if (d.strength === "strong") advisory.strong++;
        else if (d.strength === "weak") advisory.weak++;
      } else if (d.outcome === "advice_unavailable") {
        advisory.advice_unavailable++;
        bump(advisory.unavailable_by_reason, d.reason ?? "uncategorized");
      }
    } else if (g === "ask") {
      legacyAutonomous.total++;
      bump(legacyAutonomous.by_outcome, d.outcome);
    }
  }

  const answers = events.filter(isHumanAnswer);
  const agreement = { compared: 0, agree: 0, disagree: 0, partial: 0, agreement_pct: 0 };
  for (const e of answers) {
    if (e.kind !== "outcome" || !Array.isArray(e.recommended) || !["agree", "disagree", "partial"].includes(e.agreement)) continue;
    agreement.compared++;
    agreement[e.agreement]++;
  }
  agreement.agreement_pct = pct(agreement.agree, agreement.compared);

  const standdownRows = events.filter((e) => e.kind === "standdown" || (e.kind === "diagnostic" && e.outcome === "paseo_standdown"));
  /** @type {Record<string, number>} */
  const standdownReasons = {};
  const standdowns = { total: standdownRows.length, by_reason: standdownReasons };
  for (const e of standdownRows) bump(standdowns.by_reason, e.reason ?? "paseo");

  const providerErrorRows = events.filter((e) => e.kind === "provider_error");
  /** @type {Record<string, number>} */
  const providerErrorClasses = {};
  const providerErrors = { total: providerErrorRows.length, by_class: providerErrorClasses };
  for (const e of providerErrorRows) bump(providerErrors.by_class, e.error_class ?? "uncategorized");

  return {
    schema: 2,
    calls: {
      total: calls.length,
      ok: calls.filter((c) => c.status === "ok").length,
      error: callErrors,
      error_rate: ratio(callErrors, calls.length),
      by_error_class: byErrorClass,
      avg_latency_ms: avg,
      p95_latency_ms: percentile(latencies, 0.95),
      by_source: callSources,
    },
    decisions: {
      total,
      by_outcome: byOutcome,
      by_gate: byGate,
      positive_pct: pct(positive, total),
      fallback_pct: pct(fallback, total),
      by_source: decisionSources,
    },
    advisory,
    legacy_autonomous: legacyAutonomous,
    human_answers: answers.length,
    agreement,
    standdowns,
    fallbacks: fallback,
    provider_errors: providerErrors,
    user_overrides: answers.length, // DEPRECATED alias của human_answers (panel/contracts.ts) — không phải "override"
  };
}

/** Newest-first, giới hạn `limit`. Câu trả lời của người (outcome mới, user_choice cũ) trộn chung vào bảng, đội lốt outcome/label riêng. */
export function recentDecisions(events, limit = 10) {
  return events
    .filter((e) => (e.kind === "decision" && e.question) || isHumanAnswer(e))
    .map((e) => (isHumanAnswer(e) ? { ...e, outcome: "user_choice", label: (e.chosen ?? []).join(", ") } : e))
    .slice(-limit)
    .reverse();
}
