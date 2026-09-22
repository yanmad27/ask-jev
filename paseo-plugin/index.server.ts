import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getDecision, getStats } from "./server/log";
import { jevDecisionRpc, jevStatsRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(jevStatsRpc, (input) => getStats(input));
  server.handle(jevDecisionRpc, (input) => getDecision(input));
  return () => {};
}
