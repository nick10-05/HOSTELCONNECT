import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Vite writes files under 4 KB into the CSS as data: URLs. One tiny font subset was,
    // and the server's Content Security Policy (font-src 'self') blocks fonts from data:
    // URLs. Fonts always stay separate files; other assets keep Vite's default.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
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
