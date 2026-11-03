import cookieParser from "cookie-parser";
import express from "express";
import type { Db } from "./db";
import { sendError } from "./lib/http";
import { apiNotFound, errorHandler } from "./middleware/errorHandler";
import { requireSameOrigin } from "./middleware/sameOrigin";
import { authRouter } from "./routes/auth";

export type AppDeps = {
  db: Db;
  jwtSecret: string;
  // Production runs behind Render's proxy, over HTTPS.
  production?: boolean;
};

// Builds the Express app but does NOT start listening.
// Tests import this and call it directly, so they need no open port.
export function createApp({ db, jwtSecret, production = false }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  // Render puts one proxy in front of the app. Trusting exactly that one hop lets the
  // rate limiter see each visitor's real IP instead of the proxy's.
  if (production) app.set("trust proxy", 1);
  // Before the body parser, so a refused write is not even read.
  app.use("/api", requireSameOrigin);
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Liveness check that also touches the database, so the host, CI and the hourly
  // jobs workflow notice a paused or unreachable database, not just a running process.
  app.get("/api/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      // The driver's message can contain the host name, so it is not sent back.
      sendError(res, 503, "db_unavailable", "Database is unreachable");
    }
  });

  app.use("/api/auth", authRouter({ db, jwtSecret, secureCookies: production }));

  app.use("/api", apiNotFound);
  app.use(errorHandler);

  return app;
}
