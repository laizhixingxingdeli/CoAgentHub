import { createAtomCodeParser } from "../output-parser";
import type { ExecutorAdapter } from "./types";

export const atomcodeAdapter: ExecutorAdapter = {
  createParser: createAtomCodeParser,
};
