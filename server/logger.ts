import pino from "pino";

/**
 * Process-wide structured logger.
 *
 * - In dev (NODE_ENV !== "production"), uses `pino-pretty` for human-readable
 *   coloured output on stdout.
 * - In prod, emits newline-delimited JSON ready for log aggregators.
 * - `LOG_LEVEL` env var overrides the default level (`info`).
 */

const level = process.env.LOG_LEVEL ?? "info";
const isProd = process.env.NODE_ENV === "production";

export const logger = pino(
  {
    level,
    base: undefined, // omit pid/hostname noise
  },
  isProd
    ? pino.destination(1)
    : pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
          singleLine: true,
        },
      })
);

/** Helper to create a child logger with a component tag. */
export function child(component: string) {
  return logger.child({ component });
}
