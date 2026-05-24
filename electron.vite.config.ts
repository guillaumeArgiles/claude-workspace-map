import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  // ── Main process ─────────────────────────────────────────────────────────
  // Bundles electron/main.ts + server/**  + shared/** into a single CJS
  // module. Node-module deps (chokidar, pino, zod…) stay external so
  // electron-builder can package them properly.
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main.ts"),
        },
      },
    },
  },

  // ── Preload script ────────────────────────────────────────────────────────
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/preload",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload.ts"),
        },
      },
    },
  },

  // ── Renderer (Vite + React + Phaser) ─────────────────────────────────────
  renderer: {
    root: __dirname,
    build: {
      outDir: resolve(__dirname, "dist"),
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
    plugins: [react()],
    server: {
      port: 5173,
      // Proxy /api to the embedded Node server (started by main process)
      proxy: {
        "/api": {
          target: "http://localhost:4000",
          changeOrigin: true,
          ws: false,
        },
      },
    },
  },
});
