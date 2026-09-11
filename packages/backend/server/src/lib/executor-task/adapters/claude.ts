import { collectClaude } from "../token-usage";
import type { ExecutorAdapter } from "./types";

export const claudeAdapter: ExecutorAdapter = {
  collectTokenUsage: collectClaude,
};
