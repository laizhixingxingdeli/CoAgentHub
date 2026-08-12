import path from "node:path";
import { defineConfig } from "vitest/config";

// Vitest runs with jsdom: pages are rendered with @testing-library/react and
// network access is replaced by fetch mocks (see src/test/setup.ts).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
