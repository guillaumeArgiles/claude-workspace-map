import { app, BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer } from "../server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Set by electron-vite in dev mode. When present, the renderer is served by
 * the Vite dev server instead of loaded from the built `dist/` directory.
 */
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

/** Resolved paths for preload script and built renderer. */
const PRELOAD = path.join(__dirname, "../preload/index.js");
const RENDERER_DIST = path.join(__dirname, "../../dist");

let stopServer: (() => Promise<void>) | undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Claude Workspace Map",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for preload to access Node APIs via contextBridge
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    // Open DevTools automatically in dev mode
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  // Prevent in-app navigation for external URLs — open in OS browser instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url).catch(() => {
        /* ignore */
      });
    }
    return { action: "deny" };
  });

  return win;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const port = Number(process.env["PORT"] ?? 4000);

  try {
    stopServer = await startServer(port);
  } catch (err) {
    // In dev, the standalone `npm run server` might already be running on
    // this port. Log and continue — the window will proxy to it.
    console.error("[electron] Failed to start embedded server:", err);
  }

  createWindow();

  // macOS: re-create the window when the dock icon is clicked and no windows exist
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS where the app stays active)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop the server cleanly before the app exits
app.on("before-quit", async (event) => {
  if (!stopServer) return;
  event.preventDefault();
  await stopServer();
  stopServer = undefined;
  app.quit();
});
