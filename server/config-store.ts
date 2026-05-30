import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppConfigSchema, DEFAULT_CONFIG, type AppConfig } from "../shared/config-schema.js";

const CONFIG_PATH = path.join(os.homedir(), ".claude-workspace-map", "config.json");

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return AppConfigSchema.parse(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(data: unknown): Promise<AppConfig> {
  const validated = AppConfigSchema.parse(data);
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(validated, null, 2), "utf8");
  return validated;
}
