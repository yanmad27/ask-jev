import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { GATES, jevDecisionRpc, jevStatsRpc, SINCE_OPTIONS, type JevStats, type SinceOption } from "../shared/contracts";

const POLL_MS = 2000;

type Row = JevStats["recent"][number];

/** Stable identity for a row across polls — never the array index, which shifts as new lines arrive. */
function rowKey(row: Pick<Row, "ts" | "gate" | "question">): string {
  return JSON.stringify([row.ts, row.gate ?? "", row.question]);
}

function parseRowKey(key: string): { ts: string; gate?: string } {
  const [ts, gate] = JSON.parse(key) as [string, string, string];
  return { ts, gate: gate || undefined };
}

function monospace(platform: "ios" | "android" | "web"): string {
  if (platform === "android") return "monospace";
  if (platform === "web") return "ui-monospace, SFMono-Regular, Menlo, monospace";
  return "Menlo";
}

function formatFieldLabel(key: string): string {
  return key.length ? key[0].toUpperCase() + key.slice(1).replace(/_/g, " ") : key;
}

function formatFieldValue(value: unknown): string {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function AskJevPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const cwd = useWorkspace(workspaceId, (w) => w.directory) ?? undefined;
  const fetchStats = useRpc(jevStatsRpc);
  const fetchDecision = useRpc(jevDecisionRpc);
  const [allRepos, setAllRepos] = useState(false);
  const [since, setSince] = useState<SinceOption>("all");
  const [outcome, setOutcome] = useState("all");
  const [gate, setGate] = useState("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stats, setStats] = useState<JevStats | null>(null);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const mono = monospace(layout.platform);

  const load = useCallback(() => {
    fetchStats({ since, outcome, gate, cwd: allRepos ? undefined : cwd }).then(setStats).catch(() => {});
  }, [fetchStats, since, outcome, gate, cwd, allRepos]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Keyed off expandedKey only, not `stats` — the 2s poll must not re-fetch or flicker the open detail.
  useEffect(() => {
    if (!expandedKey) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchDecision(parseRowKey(expandedKey))
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedKey, fetchDecision]);

  if (!stats) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (!stats.hasLog) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>No log yet at {stats.logPath}</Text>
      </View>
    );
  }

  const outcomes = Object.keys(stats.decisions.by_outcome);

  return (
    <View style={styles.screen}>
      <View style={styles.row}>
        <Chip styles={styles} active={!allRepos} label="This repo" onPress={() => setAllRepos(false)} />
        <Chip styles={styles} active={allRepos} label="All repos" onPress={() => setAllRepos(true)} />
        <Text style={[styles.muted, { alignSelf: "center" }]}>{stats.scope}</Text>
      </View>
      <View style={styles.tiles}>
        <Tile styles={styles} label="Calls" value={String(stats.calls.total)} />
        <Tile styles={styles} label="Jev decided" value={`${stats.decisions.positive_pct.toFixed(0)}%`} />
        <Tile styles={styles} label="Fell back to user" value={`${stats.decisions.fallback_pct.toFixed(0)}%`} />
        <Tile styles={styles} label="User overrides" value={String(stats.user_overrides)} />
        <Tile styles={styles} label="Avg / p95 latency" value={`${stats.calls.avg_latency_ms}ms / ${stats.calls.p95_latency_ms}ms`} />
      </View>

      <View style={styles.row}>
        {SINCE_OPTIONS.map((opt) => (
          <Chip key={opt} styles={styles} active={since === opt} label={opt === "all" ? "All time" : opt} onPress={() => setSince(opt)} />
        ))}
      </View>

      <View style={styles.row}>
        <Chip styles={styles} active={gate === "all"} label="All gates" onPress={() => setGate("all")} />
        {GATES.map((g) => (
          <Chip
            key={g}
            styles={styles}
            active={gate === g}
            label={`${g} (${stats.decisions.by_gate[g]?.total ?? 0})`}
            onPress={() => setGate(g)}
          />
        ))}
      </View>

      <View style={styles.row}>
        <Chip styles={styles} active={outcome === "all"} label="All outcomes" onPress={() => setOutcome("all")} />
        {outcomes.map((o) => (
          <Chip
            key={o}
            styles={styles}
            active={outcome === o}
            label={`${o} (${stats.decisions.by_outcome[o]})`}
            onPress={() => setOutcome(o)}
          />
        ))}
      </View>

      <View style={styles.tableHeader}>
        <Text style={[styles.cell, styles.colTime]}>Time</Text>
        <Text style={[styles.cell, styles.colGate]}>Gate</Text>
        <Text style={[styles.cell, styles.colOutcome]}>Outcome</Text>
        <Text style={[styles.cell, styles.colQuestion]}>Question/Subject</Text>
        <Text style={[styles.cell, styles.colAnswer]}>Answer</Text>
        <Text style={[styles.cell, styles.colReason]}>Reason</Text>
      </View>
      <FlatList
        data={stats.recent}
        keyExtractor={rowKey}
        style={styles.table}
        renderItem={({ item }) => {
          const key = rowKey(item);
          const isExpanded = expandedKey === key;
          return (
            <View>
              <Pressable
                style={[styles.tableRow, isExpanded && styles.tableRowActive]}
                onPress={() => setExpandedKey(isExpanded ? null : key)}
              >
                <Text style={[styles.cell, styles.colTime, styles.muted]}>{formatTime(item.ts)}</Text>
                <Text style={[styles.cell, styles.colGate]}>{item.gate ?? "—"}</Text>
                <Text style={[styles.cell, styles.colOutcome, { color: outcomeColor(theme, item.gate, item.outcome) }]}>{item.outcome}</Text>
                <Text style={[styles.cell, styles.colQuestion]} numberOfLines={1}>
                  {item.question}
                </Text>
                <Text style={[styles.cell, styles.colAnswer]} numberOfLines={1}>
                  {item.label ? `${item.label}${item.confidence != null ? ` ${item.confidence.toFixed(2)}` : ""}` : "—"}
                </Text>
                <Text style={[styles.cell, styles.colReason, styles.muted]} numberOfLines={1}>
                  {item.reason ?? "—"}
                </Text>
              </Pressable>
              {isExpanded ? (
                <View style={styles.detail}>
                  {detailLoading && !detail ? (
                    <Text style={styles.muted}>Loading…</Text>
                  ) : detail ? (
                    <>
                      <View style={styles.detailLeft}>
                        {Object.entries(detail)
                          .filter(([field]) => LONG_TEXT_FIELDS.has(field))
                          .map(([field, value]) => (
                            <View key={field} style={styles.detailRow}>
                              <Text style={styles.detailLabel}>{formatFieldLabel(field)}</Text>
                              <Text
                                selectable
                                style={[styles.detailValue, field === "question" && { fontFamily: mono }]}
                              >
                                {formatFieldValue(value)}
                              </Text>
                            </View>
                          ))}
                      </View>
                      <View style={styles.detailRight}>
                        {Object.entries(detail)
                          .filter(([field]) => !LONG_TEXT_FIELDS.has(field))
                          .map(([field, value]) => (
                            <View key={field} style={styles.detailRow}>
                              <Text style={styles.detailLabel}>{formatFieldLabel(field)}</Text>
                              <Text selectable style={styles.detailValue}>
                                {formatFieldValue(value)}
                              </Text>
                            </View>
                          ))}
                        <Pressable accessibilityRole="button" onPress={() => setExpandedKey(null)} style={styles.detailClose}>
                          <Text style={styles.detailCloseText}>Close</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <Text style={styles.muted}>Could not load the full record.</Text>
                  )}
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.muted}>No decisions in range.</Text>}
      />
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function Tile({ styles, label, value }: { styles: Styles; label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function Chip({ styles, active, label, onPress }: { styles: Styles; active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// Mirrors lib/stats.mjs's POSITIVE map — kept small and local since it's presentational only.
const POSITIVE: Record<string, string[]> = { ask: ["answered"], permission: ["allow"], stop: ["ok"], bash: ["success"], prompt: ["clear"] };

const LONG_TEXT_FIELDS = new Set(["question", "reason"]);

function outcomeColor(theme: PluginTheme, gate: string | undefined, outcome: string): string {
  if (gate && (POSITIVE[gate] ?? []).includes(outcome)) return theme.colors.statusSuccess;
  if (outcome === "error" || outcome === "no_key" || outcome === "block") return theme.colors.statusDanger;
  return theme.colors.statusWarning;
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  const pad = compact ? 12 : 16;
  return {
    screen: { flex: 1, padding: pad, backgroundColor: theme.colors.surface0, gap: 12 },
    tiles: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
    tile: {
      flexGrow: 1,
      minWidth: 120,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
    },
    tileValue: { fontSize: 20, fontWeight: "600" as const, color: theme.colors.foreground },
    tileLabel: { fontSize: 12, color: theme.colors.foregroundMuted, marginTop: 2 },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    chipText: { fontSize: 12, color: theme.colors.foreground },
    chipTextActive: { color: theme.colors.accentForeground },
    table: { flex: 1 },
    tableHeader: {
      flexDirection: "row" as const,
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
      paddingVertical: 6,
    },
    tableRow: {
      flexDirection: "row" as const,
      borderBottomWidth: 1,
      borderColor: theme.colors.surface2,
      paddingVertical: 6,
    },
    tableRowActive: { backgroundColor: theme.colors.surface1 },
    cell: { fontSize: 12, color: theme.colors.foreground, paddingHorizontal: 4 },
    colTime: { width: compact ? 90 : 150 },
    colGate: { width: 80 },
    colOutcome: { width: 100 },
    colQuestion: { flex: 2 },
    colAnswer: { width: compact ? 100 : 140 },
    colReason: { flex: compact ? 1 : 2 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    detail: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      backgroundColor: theme.colors.surface1,
      borderBottomWidth: 1,
      borderColor: theme.colors.surface2,
      padding: 10,
      gap: 16,
    },
    detailLeft: { flex: 3, minWidth: 220, gap: 8 },
    detailRight: { flex: 1, minWidth: compact ? 220 : 280, gap: 8 },
    detailRow: { gap: 2 },
    detailLabel: { fontSize: 11, color: theme.colors.foregroundMuted, textTransform: "uppercase" as const },
    detailValue: { fontSize: 13, color: theme.colors.foreground, flexWrap: "wrap" as const },
    detailClose: { alignSelf: "flex-start" as const, marginTop: 4, paddingVertical: 4, paddingHorizontal: 10 },
    detailCloseText: { fontSize: 12, color: theme.colors.accent, fontWeight: "600" as const },
  };
}
