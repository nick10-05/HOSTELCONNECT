import express from "express";
import type { Db } from "./db";

export type AppDeps = { db: Db };

// Builds the Express app but does NOT start listening.
// Tests import this and call it directly, so they need no open port.
export function createApp({ db }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Liveness check that also touches the database, so the host, CI and the hourly
  // jobs workflow notice a paused or unreachable database, not just a running process.
  app.get("/api/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      // The driver's message can contain the host name, so it is not sent back.
      res.status(503).json({
        error: { code: "db_unavailable", message: "Database is unreachable" },
      });
    }
  });

  return app;
}
