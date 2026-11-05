import path from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
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
  // server/dist/index.js -> client/dist, the same layout in the repo and the Docker image.
  clientDir: production ? path.resolve(__dirname, "../../client/dist") : undefined,
});

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
