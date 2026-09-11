import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { config as dotenv } from "dotenv";

dotenv();

export interface AppConfig {
  passwordHash: string;
  port: number;
  setupComplete: boolean;
}

export class ConfigStore {
  private cached?: AppConfig;
  readonly directory: string;

  constructor(directory?: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.directory = resolve(directory || env.OPENMYMODEL_DATA_DIR || env.DATA_DIR || join(process.cwd(), "data"));
  }

  load(): AppConfig {
    if (this.cached) return this.cached;
    const file = join(this.directory, "config.json");
    const port = Number(this.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    const config: AppConfig = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { passwordHash: "", port, setupComplete: false };
    if (!config || typeof config.passwordHash !== "string" || typeof config.setupComplete !== "boolean"
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error("Invalid backend configuration");
    }
    this.cached = config;
    return config;
  }

  async initialize(): Promise<AppConfig> {
    const config = this.load();
    if (!config.setupComplete && this.env.ADMIN_PASSWORD) {
      const { hashPassword } = await import("./services/auth");
      this.save({ ...config, passwordHash: await hashPassword(this.env.ADMIN_PASSWORD), setupComplete: true });
    }
    return this.load();
  }

  save(config: AppConfig): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
    this.cached = config;
  }
}

let defaultStore: ConfigStore | undefined;
export function getConfigStore(): ConfigStore {
  return defaultStore ??= new ConfigStore();
}
export function getConfigDir(): string {
  const directory = getConfigStore().directory;
  mkdirSync(directory, { recursive: true });
  return directory;
}
export const loadConfig = (): AppConfig => getConfigStore().load();
export const getConfig = loadConfig;
export const saveConfig = (config: AppConfig): void => getConfigStore().save(config);
