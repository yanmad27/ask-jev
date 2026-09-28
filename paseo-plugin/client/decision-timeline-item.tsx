import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { z } from "zod";
import type { AskJevTimelineDataSchema } from "../shared/contracts";

type Data = z.infer<typeof AskJevTimelineDataSchema>;

/** Minimal renderer for the `Jev chose "X" (0.93)` line appended via timeline.append() —
 * without a registered client.addTimelineRenderer for its kind, a plugin timeline item has
 * nothing to render it and never shows up anywhere in the agent's timeline. */
export function AskJevDecisionTimelineItem({ item, theme }: PluginTimelineItemProps<Data>) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{item.data.text}</Text>;
}
