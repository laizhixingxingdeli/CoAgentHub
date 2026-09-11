import { createCodexParser } from "../output-parser";
import { extractCodexExecText, tokenUsageFromCodexJsonl } from "../token-usage";
import type { ExecutorAdapter } from "./types";

export const codexAdapter: ExecutorAdapter = {
  createParser: createCodexParser,
  collectTokenUsage: (input) => tokenUsageFromCodexJsonl(input.stdout ?? ""),
  extractFinalText: extractCodexExecText,
};
