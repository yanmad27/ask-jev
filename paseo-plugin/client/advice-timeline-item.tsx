import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { AskJevAdviceData } from "../shared/contracts";

/** Renders the `Jev advice: "X" (0.86) — reason` / `Jev advice unavailable — …` line appended while a
 * question is still pending. Advice is advisory only: the human answers the question card as usual. */
export function AskJevAdviceTimelineItem({ item, theme }: PluginTimelineItemProps<AskJevAdviceData>) {
  const advised = item.data.status === "advised";
  return (
    <Text style={{ color: advised ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontStyle: advised ? "normal" : "italic" }}>
      {item.data.text}
    </Text>
  );
}
