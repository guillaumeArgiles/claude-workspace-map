/**
 * Standalone entry point for the HTTP server.
 * Used by `npm run server` (tsx watch) in non-Electron development.
 *
 * In Electron builds, `electron/main.ts` imports `startServer` from
 * `./index.ts` directly — this file is never loaded in that case.
 */

import { startServer } from "./index.js";

const PORT = Number(process.env.PORT ?? 4000);

const stop = await startServer(PORT);

process.on("SIGINT", () => stop().then(() => process.exit(0)));
process.on("SIGTERM", () => stop().then(() => process.exit(0)));
