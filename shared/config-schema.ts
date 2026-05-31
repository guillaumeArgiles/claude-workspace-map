import { z } from "zod";

export const AppConfigSchema = z.object({
  theme: z.enum(["dark", "light"]).default("dark"),
  sidebarWidth: z.number().min(200).max(600).default(340),
  port: z.number().default(4000),
  locale: z.enum(["en", "fr", "es"]).default("en"),
  /** When true, Le Professeur's responses are read aloud via the browser's
   *  built-in Web Speech API (no network, no API key). Off by default. */
  voiceEnabled: z.boolean().default(false),
});

export type Locale = z.infer<typeof AppConfigSchema>["locale"];
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr", "es"];

export type AppConfig = z.infer<typeof AppConfigSchema>;
export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});
