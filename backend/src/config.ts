import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config as dotenv } from "dotenv";
import { createHash, randomBytes } from "crypto";

dotenv();

const CONFIG_DIR = join(process.cwd(), "data");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface AppConfig {
  passwordHash: string;
  port: number;
  setupComplete: boolean;
}

let _config: AppConfig | null = null;

export function getConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

export function loadConfig(): AppConfig {
  if (_config) return _config;

  if (existsSync(CONFIG_FILE)) {
    _config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } else {
    // Auto-init for Docker: use env vars to create config
    const password = process.env.ADMIN_PASSWORD || "";
    const port = parseInt(process.env.PORT || "3000");

    if (password) {
      _config = {
        passwordHash: hashPassword(password),
        port,
        setupComplete: true,
      };
      getConfigDir();
      writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), "utf-8");
      console.log("[auto-init] Config created from env, port=%d", port);
    } else {
      _config = {
        passwordHash: "",
        port,
        setupComplete: false,
      };
    }
  }
  return _config!;
}

export function saveConfig(config: AppConfig): void {
  getConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  _config = config;
}

export function getConfig(): AppConfig {
  return loadConfig();
}
