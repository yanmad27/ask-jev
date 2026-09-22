import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { GATES, jevStatsRpc, SINCE_OPTIONS, type JevStats, type SinceOption } from "../shared/contracts";

const POLL_MS = 2000;

export function AskJevPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const fetchStats = useRpc(jevStatsRpc);
  const [since, setSince] = useState<SinceOption>("all");
  const [outcome, setOutcome] = useState("all");
  const [gate, setGate] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [stats, setStats] = useState<JevStats | null>(null);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  const load = useCallback(() => {
    fetchStats({ since, outcome, gate }).then(setStats).catch(() => {});
  }, [fetchStats, since, outcome, gate]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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
        keyExtractor={(item, i) => `${item.ts}-${i}`}
        style={styles.table}
        renderItem={({ item, index }) => {
          const isExpanded = expanded === index;
          return (
            <Pressable style={styles.tableRow} onPress={() => setExpanded(isExpanded ? null : index)}>
              <Text style={[styles.cell, styles.colTime, styles.muted]}>{formatTime(item.ts)}</Text>
              <Text style={[styles.cell, styles.colGate]}>{item.gate ?? "—"}</Text>
              <Text style={[styles.cell, styles.colOutcome, { color: outcomeColor(theme, item.gate, item.outcome) }]}>{item.outcome}</Text>
              <Text style={[styles.cell, styles.colQuestion]} numberOfLines={isExpanded ? undefined : 1}>
                {item.question}
              </Text>
              <Text style={[styles.cell, styles.colAnswer]} numberOfLines={1}>
                {item.label ? `${item.label}${item.confidence != null ? ` ${item.confidence.toFixed(2)}` : ""}` : "—"}
              </Text>
              <Text style={[styles.cell, styles.colReason, styles.muted]} numberOfLines={isExpanded ? undefined : 1}>
                {item.reason ?? "—"}
              </Text>
            </Pressable>
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
    cell: { fontSize: 12, color: theme.colors.foreground, paddingHorizontal: 4 },
    colTime: { width: compact ? 90 : 150 },
    colGate: { width: 80 },
    colOutcome: { width: 100 },
    colQuestion: { flex: 2 },
    colAnswer: { width: compact ? 100 : 140 },
    colReason: { flex: compact ? 1 : 2 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
  };
}
