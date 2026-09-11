import { createCodeBuddyParser } from "../output-parser";
import { extractCodeBuddyStreamResult } from "../report";
import { collectCodeBuddy } from "../token-usage";
import type { ExecutorAdapter } from "./types";

export const codebuddyAdapter: ExecutorAdapter = {
  createParser: createCodeBuddyParser,
  collectTokenUsage: collectCodeBuddy,
  extractFinalText: extractCodeBuddyStreamResult,
};
