import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config as dotenv } from "dotenv";

dotenv();

const CONFIG_DIR = join(process.cwd(), "data");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface AppConfig {
  domain: string;          // 服务器域名，如 aiapi.topofmoon.com
  password: string;        // 管理员密码（首次设置后不可直接读取）
  passwordHash: string;    // 密码哈希
  port: number;            // HTTP 端口
  setupComplete: boolean;  // 是否已完成初始化
}

let _config: AppConfig | null = null;

export function getConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}

export function loadConfig(): AppConfig {
  if (_config) return _config;

  if (existsSync(CONFIG_FILE)) {
    _config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } else {
    _config = {
      domain: "",
      password: "",
      passwordHash: "",
      port: parseInt(process.env.PORT || "3000"),
      setupComplete: false,
    };
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