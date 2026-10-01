import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { AskJevAdviceData } from "../shared/contracts";

/** Renders advice appended while a question is still pending. Advice is advisory only: the human
 * answers the question card as usual. The recommendation, confidence and the option's own description
 * are separate spans (label and description are agent-authored text, so they are never concatenated
 * into the sentence that states Jev's confidence). */
export function AskJevAdviceTimelineItem({ item, theme }: PluginTimelineItemProps<AskJevAdviceData>) {
  const { data } = item;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const question = (data.question_count ?? 1) > 1 ? <Text style={muted}>{`[${data.question}] `}</Text> : null;

  if (data.status !== "advised") {
    return (
      <Text style={{ ...muted, fontStyle: "italic" }}>
        {question}
        {data.text}
      </Text>
    );
  }
  const pick = data.recommended.length > 0 ? data.recommended.map((l) => `"${l}"`).join(", ") : "no option";
  return (
    <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
      {question}
      <Text>{"Jev advice: "}</Text>
      <Text style={{ fontWeight: "600" }}>{pick}</Text>
      <Text>{` — confidence ${(data.confidence ?? 0).toFixed(2)}${data.strength === "weak" ? " (low)" : ""} · `}</Text>
      <Text style={{ ...muted, fontStyle: "italic" }}>{`option description: “${data.reason}”`}</Text>
    </Text>
  );
}
