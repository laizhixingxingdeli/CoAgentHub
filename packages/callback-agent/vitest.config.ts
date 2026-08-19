import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**", "**/node_modules/**"],
    globals: true,
    environment: "node",
  },
});
