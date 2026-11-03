import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { loadDotEnv } from "./loadEnv";

loadDotEnv();
const config = loadConfig();
const db = createPool(config.DATABASE_URL);

const app = createApp({
  db,
  jwtSecret: config.JWT_SECRET,
  production: config.NODE_ENV === "production",
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
