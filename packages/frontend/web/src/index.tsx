import "./instrument.ts";
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./router.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}

createRoot(container, {
  onUncaughtError: Sentry.reactErrorHandler((error, info) => {
    console.warn("Uncaught error", error, info?.componentStack);
  }),
  onCaughtError: Sentry.reactErrorHandler((error, info) => {
    console.warn("Caught error", error, info?.componentStack);
  }),
}).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>页面发生错误</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
