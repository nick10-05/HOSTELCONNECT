import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development the browser talks only to Vite, which forwards API calls to
    // Express. One origin, as in production, so the session cookie just works.
    proxy: {
      // changeOrigin false keeps the browser's Host header (localhost:5173), so the
      // server's same-origin check sees it match the Origin. Vite 8 rewrites Host to
      // the target unless told not to, and every login was refused as cross-site.
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
