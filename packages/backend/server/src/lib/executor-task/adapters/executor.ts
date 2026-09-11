import { createAtomCodeParser } from "../output-parser";
import { collectAtomCode } from "../token-usage";
import type { ExecutorAdapter } from "./types";

export const executorAdapter: ExecutorAdapter = {
  createParser: createAtomCodeParser,
  collectTokenUsage: collectAtomCode,
};
