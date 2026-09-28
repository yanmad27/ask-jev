import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AskJevPanel } from "./client/panel";
import { AskJevDecisionTimelineItem } from "./client/decision-timeline-item";
import { ASK_JEV_TIMELINE_KIND, ASK_JEV_TIMELINE_VERSION, AskJevTimelineDataSchema } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  // Without this, the `Jev chose "X" (0.93)` items server/permission-answerer.ts appends via
  // timeline.append({type:"plugin", ...}) have no renderer and never show up anywhere.
  const removeTimelineRenderer = client.addTimelineRenderer({
    kind: ASK_JEV_TIMELINE_KIND,
    version: ASK_JEV_TIMELINE_VERSION,
    schema: AskJevTimelineDataSchema,
    Component: AskJevDecisionTimelineItem,
  });

  const removePanel = client.addWorkspacePanel({
    id: "ask-jev",
    title: "Ask Jev",
    icon: "Activity",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: AskJevPanel,
  });

  // addWorkspacePanel alone isn't Cmd+K searchable — Command Center only indexes
  // addCommandCenterItem entries, so the panel needs one to be discoverable.
  const removeCommand = client.addCommandCenterItem({
    id: "open-ask-jev",
    title: "Ask Jev: usage log",
    icon: "Activity",
    keywords: ["jev", "ask-jev", "usage", "stats", "decisions", "log"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("ask-jev");
    },
  });

  return () => {
    removeTimelineRenderer();
    removePanel();
    removeCommand();
  };
}
