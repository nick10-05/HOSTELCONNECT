import express from "express";

// Builds the Express app but does NOT start listening.
// Tests import this and call it directly, so they need no open port.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Later this will also check the database (day 2, step 5).
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
