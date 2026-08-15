import path from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // 局域网可访问(与生产模式 serve.mjs 一致);dev 时其他设备走 :5173
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // The messages page keeps a live WebSocket to /api/ws; without this
        // the dev proxy drops the upgrade and WS only works on :3001.
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: "coagenthub",
      project: "web",
      telemetry: false,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: { sourcemap: true },
});
