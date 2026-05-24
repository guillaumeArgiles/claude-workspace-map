import { contextBridge } from "electron";

/**
 * Minimal preload script.
 *
 * Exposes safe, read-only metadata to the renderer via `window.electronAPI`.
 * This surface will grow in Phase 2 (PTY integration, native notifications).
 *
 * Security rules:
 * - contextIsolation: true (main process code is never accessible to renderer)
 * - nodeIntegration: false (renderer cannot use Node APIs directly)
 * - Only expose what the renderer actually needs
 */
contextBridge.exposeInMainWorld("electronAPI", {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  platform: process.platform,
});
