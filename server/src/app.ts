import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Db } from "./db";
import { isAppPage } from "./lib/appPages";
import { sendError } from "./lib/http";
import type { PhotoStorage } from "./lib/storage";
import { apiNotFound, errorHandler } from "./middleware/errorHandler";
import { requireSameOrigin } from "./middleware/sameOrigin";
import { securityHeaders } from "./middleware/securityHeaders";
import { announcementsRouter } from "./routes/announcements";
import { authRouter } from "./routes/auth";
import { hostelsRouter } from "./routes/hostels";
import { googleRouter } from "./routes/google";
import { signupRouter } from "./routes/signup";
import type { GoogleAuth } from "./lib/google";
import { complaintsRouter } from "./routes/complaints";
import { dashboardRouter } from "./routes/dashboard";
import { feesRouter } from "./routes/fees";
import { foodRouter } from "./routes/food";
import { internalRouter } from "./routes/internal";
import { notificationsRouter } from "./routes/notifications";
import { rejoinRouter } from "./routes/rejoin";
import { returnPollsRouter } from "./routes/returnPolls";
import { settingsRouter } from "./routes/settings";
import { structureRouter } from "./routes/structure";
import { studentsRouter } from "./routes/students";
import type { ComplaintLimits } from "./services/complaints";
import type { UsageLimits } from "./services/usage";

export type AppDeps = {
  db: Db;
  jwtSecret: string;
  // Production runs behind Render's proxy, over HTTPS.
  production?: boolean;
  // Folder of the built React app (client/dist). Given in production only; in
  // development Vite serves the pages and forwards /api here.
  clientDir?: string;
  // From config (COMPLAINT_MAX_ACTIVE, COMPLAINT_MAX_NEW_PER_DAY); the design's 3 and 2
  // when not given.
  complaintLimits?: ComplaintLimits;
  // JOB_SECRET; without it POST /api/internal/run-jobs does not exist.
  jobSecret?: string;
  // Supabase Storage for complaint photos (storageFromConfig); null or missing: photo
  // uploads are off.
  storage?: PhotoStorage | null;
  // PHOTO_MAX_BYTES; 1 MB when not given.
  photoMaxBytes?: number;
  // PHOTO_LINK_SECONDS, how long a photo link works; 60 when not given.
  photoLinkSeconds?: number;
  // STORAGE_LIMIT_MB and EGRESS_LIMIT_MB for the usage guard; 450 and 3000 when not given.
  usageLimits?: UsageLimits;
  // The time the jobs run at, the usage guard reads its month from and the food counts
  // take India's today from, as do the fee routes; tests pass a fixed one.
  clock?: () => Date;
  // The origin complaint photos are shown from (SUPABASE_URL), allowed by the Content
  // Security Policy; null or missing when photo storage is off.
  photoOrigin?: string | null;
  // CSP_REPORT_ONLY: browsers only report policy breaks instead of blocking them.
  cspReportOnly?: boolean;
  // Google sign-in for owners (googleFromConfig); null or missing: it is off.
  google?: GoogleAuth | null;
  // SIGNUPS_OPEN: new owners may sign up (with Google). Off when not given.
  signupsOpen?: boolean;
};

const DEFAULT_COMPLAINT_LIMITS: ComplaintLimits = { maxActive: 3, maxNewPer24h: 2 };
const DEFAULT_USAGE_LIMITS: UsageLimits = { storageLimitMb: 450, egressLimitMb: 3000 };

// Builds the Express app but does NOT start listening.
// Tests import this and call it directly, so they need no open port.
export function createApp({
  db,
  jwtSecret,
  production = false,
  clientDir,
  complaintLimits = DEFAULT_COMPLAINT_LIMITS,
  jobSecret,
  storage = null,
  photoMaxBytes = 1024 * 1024,
  photoLinkSeconds = 60,
  usageLimits = DEFAULT_USAGE_LIMITS,
  clock = () => new Date(),
  photoOrigin = null,
  cspReportOnly = false,
  google = null,
  signupsOpen = false,
}: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  // Render puts one proxy in front of the app. Trusting exactly that one hop lets the
  // rate limiter see each visitor's real IP instead of the proxy's.
  if (production) app.set("trust proxy", 1);
  // First, so every answer carries them: pages, files, the API and errors.
  app.use(securityHeaders({ production, photoOrigin, reportOnly: cspReportOnly }));
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
  // Sign-up needs Google: without it, it stays closed whatever SIGNUPS_OPEN says.
  const signupsOn = signupsOpen && google !== null;
  app.use("/api/auth", googleRouter({ db, jwtSecret, secureCookies: production, google, signupsOpen: signupsOn }));
  app.use("/api", signupRouter({ db, jwtSecret, secureCookies: production, signupsOpen: signupsOn }));
  app.use("/api", hostelsRouter({ db, jwtSecret }));
  app.use("/api", structureRouter({ db, jwtSecret }));
  app.use("/api", studentsRouter({ db, jwtSecret }));
  app.use("/api", rejoinRouter({ db, jwtSecret }));
  app.use("/api", notificationsRouter({ db, jwtSecret }));
  app.use("/api", dashboardRouter({ db, jwtSecret, storage, usageLimits, clock }));
  app.use(
    "/api",
    complaintsRouter({
      db,
      jwtSecret,
      limits: complaintLimits,
      storage,
      photoMaxBytes,
      photoLinkSeconds,
      usageLimits,
      clock,
    }),
  );
  app.use("/api", announcementsRouter({ db, jwtSecret }));
  app.use("/api", returnPollsRouter({ db, jwtSecret }));
  app.use("/api", foodRouter({ db, jwtSecret, clock }));
  app.use("/api", feesRouter({ db, jwtSecret, clock }));
  app.use("/api", settingsRouter({ db, jwtSecret }));
  app.use("/api", internalRouter({ db, jobSecret, storage, clock }));

  app.use("/api", apiNotFound);
  if (clientDir) serveClient(app, clientDir);
  app.use(errorHandler);

  return app;
}

// Page and API come from the same origin, so the session cookie and the Origin check
// need no cross-site setup.
function serveClient(app: Express, clientDir: string): void {
  const indexHtml = path.resolve(clientDir, "index.html");
  // Fail at startup, not on the first visitor, if the image was built without the client.
  if (!existsSync(indexHtml)) throw new Error(`Client build not found: ${indexHtml} is missing`);

  // Vite puts a content hash in every asset name (index-Bx12ab.js), so a changed file
  // gets a new name and the old one can be cached forever.
  app.use("/assets", express.static(path.join(clientDir, "assets"), { maxAge: "1y", immutable: true }));
  // An asset an old page asks for after a deploy: a plain 404, not index.html,
  // which the browser would fail to run as JavaScript.
  app.use("/assets", (_req, res) => {
    res.sendStatus(404);
  });
  // Other files Vite copies to the root of the build (favicon and the like).
  app.use(express.static(clientDir, { index: false }));
  // Every other page is the React app, which picks the screen from the URL. no-cache
  // makes the browser check for a new index.html on each visit, so a deploy shows at once.
  // An address the app has no page for gets 404, and the app says "Page not found".
  app.get("/{*path}", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.status(isAppPage(req.path) ? 200 : 404).sendFile(indexHtml);
  });
}
