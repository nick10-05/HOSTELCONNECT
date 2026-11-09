import path from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { googleFromConfig } from "./lib/google";
import { storageFromConfig } from "./lib/storage";
import { adoptFeesStartDate } from "./services/hostels";
import { loadDotEnv } from "./loadEnv";

loadDotEnv();
const config = loadConfig();
const db = createPool(config.DATABASE_URL);

const production = config.NODE_ENV === "production";
const app = createApp({
  db,
  jwtSecret: config.JWT_SECRET,
  production,
  complaintLimits: {
    maxActive: config.COMPLAINT_MAX_ACTIVE,
    maxNewPer24h: config.COMPLAINT_MAX_NEW_PER_DAY,
  },
  jobSecret: config.JOB_SECRET,
  storage: storageFromConfig(config),
  photoMaxBytes: config.PHOTO_MAX_BYTES,
  photoLinkSeconds: config.PHOTO_LINK_SECONDS,
  usageLimits: { storageLimitMb: config.STORAGE_LIMIT_MB, egressLimitMb: config.EGRESS_LIMIT_MB },
  // Already https with no path (config), so it is the origin photo links point to.
  photoOrigin: config.SUPABASE_URL ?? null,
  cspReportOnly: config.CSP_REPORT_ONLY,
  google: googleFromConfig(config),
  signupsOpen: config.SIGNUPS_OPEN,
  // server/dist/index.js -> client/dist, the same layout in the repo and the Docker image.
  clientDir: production ? path.resolve(__dirname, "../../client/dist") : undefined,
});

// FEES_START_DATE becomes hostel #1's own fees start date, once (phase 5a).
adoptFeesStartDate(db, config.FEES_START_DATE)
  .then((written) => {
    if (written) console.log("FEES_START_DATE is now hostel #1's fees start date; the owner changes it in Settings.");
  })
  .catch((err) => console.error("Could not give hostel #1 the FEES_START_DATE", err));

const server = app.listen(config.PORT, () => {
  console.log(`HostelConnect server listening on port ${config.PORT}`);
});

// Render sends SIGTERM before replacing the container: finish open requests,
// then close the database connections cleanly.
process.on("SIGTERM", () => {
  server.close(() => {
    void db.end();
  });
});
