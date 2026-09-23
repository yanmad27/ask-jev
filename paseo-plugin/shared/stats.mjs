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
  ask: ["answered"],
  permission: ["allow"],
  stop: ["ok"],
  bash: ["success"],
  prompt: ["clear"],
};

/** "Fell back to user": câu hỏi/permission thực sự quay lại tay người — chỉ hai trường hợp này. */
function isFallback(d) {
  if (d.gate === "ask") return d.outcome !== "answered";
  if (d.gate === "permission") return d.outcome === "ask";
  return false;
}

export function computeStats(events) {
  const calls = events.filter((e) => e.kind === "call");
  const decisions = events.filter((e) => e.kind === "decision");
  const latencies = calls.map((c) => c.latency_ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const byOutcome = {};
  const byGate = {};
  let positive = 0;
  let fallback = 0;
  for (const d of decisions) {
    byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
    const g = d.gate ?? "unknown";
    byGate[g] ??= { total: 0, positive: 0, by_outcome: {} };
    byGate[g].total++;
    byGate[g].by_outcome[d.outcome] = (byGate[g].by_outcome[d.outcome] ?? 0) + 1;
    if ((POSITIVE[g] ?? []).includes(d.outcome)) {
      byGate[g].positive++;
      positive++;
    }
    if (isFallback(d)) fallback++;
  }

  return {
    calls: {
      total: calls.length,
      ok: calls.filter((c) => c.status === "ok").length,
      error: calls.filter((c) => c.status === "error").length,
      avg_latency_ms: avg,
      p95_latency_ms: percentile(latencies, 0.95),
    },
    decisions: {
      total: decisions.length,
      by_outcome: byOutcome,
      by_gate: byGate,
      positive_pct: decisions.length ? (positive / decisions.length) * 100 : 0,
      fallback_pct: decisions.length ? (fallback / decisions.length) * 100 : 0,
    },
    user_overrides: events.filter((e) => e.kind === "user_choice").length,
  };
}

/** Newest-first, giới hạn `limit`. user_choice trộn chung vào bảng, đội lốt outcome/label riêng. */
export function recentDecisions(events, limit = 10) {
  return events
    .filter((e) => (e.kind === "decision" && e.question) || e.kind === "user_choice")
    .map((e) => (e.kind === "user_choice" ? { ...e, outcome: "user_choice", label: (e.chosen ?? []).join(", ") } : e))
    .slice(-limit)
    .reverse();
}
