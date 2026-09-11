import { createPiParser } from "../output-parser";
import type { ExecutorAdapter } from "./types";

export const piAdapter: ExecutorAdapter = {
  createParser: createPiParser,
};
