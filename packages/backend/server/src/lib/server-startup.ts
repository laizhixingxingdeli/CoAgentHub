import type { Server as HttpServer } from "node:http";
import { createAdaptorServer } from "@hono/node-server";

interface StartServerOptions {
  fetch: Parameters<typeof createAdaptorServer>[0]["fetch"];
  port: number;
  serverFactory?: () => HttpServer;
  recoverInterruptedTasks: () => Promise<unknown>;
  restoreExecutorCooldowns?: () => Promise<unknown>;
  /**
   * Omitted by production wiring (index.ts): built-in executors are no longer
   * auto-registered as participants at boot. Onboarding is now always an
   * explicit step (POST /api/participants), which already resolves
   * executorKey by matching the registered name against known executor
   * configs (see findExecutorKeyByInitialName) — so manual onboarding wires
   * up routing correctly without this callback. Kept optional so tests and
   * any future admin "resync" flow can still opt in.
   */
  ensureExecutorParticipants?: () => Promise<unknown>;
  onListening?: (server: HttpServer, port: number) => void;
}

/**
 * Bind the HTTP port before running any startup cleanup that writes to the
 * database. A failed second instance must not mutate the healthy instance's
 * task state.
 */
export async function startServer({
  fetch,
  port,
  serverFactory,
  recoverInterruptedTasks,
  restoreExecutorCooldowns,
  ensureExecutorParticipants,
  onListening,
}: StartServerOptions): Promise<HttpServer> {
  const server =
    serverFactory?.() ?? (createAdaptorServer({ fetch }) as HttpServer);
  await listen(server, port);
  onListening?.(server, port);

  try {
    await recoverInterruptedTasks();
  } catch (err) {
    console.warn("[executor] task recovery failed, continuing startup:", err);
  }

  if (restoreExecutorCooldowns) {
    try {
      await restoreExecutorCooldowns();
    } catch (err) {
      console.warn(
        "[executor] cooldown recovery failed, continuing startup:",
        err,
      );
    }
  }

  if (ensureExecutorParticipants) {
    try {
      await ensureExecutorParticipants();
    } catch (err) {
      console.warn(
        "[executor] participant auto-registration failed, continuing:",
        err,
      );
    }
  }

  return server;
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", handleListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Unable to start CoAgentHub server: port ${port} is already in use; another server instance may already be running.`,
            { cause: err },
          ),
        );
        return;
      }
      reject(err);
    };
    const handleListening = () => {
      server.removeListener("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port);
  });
}
