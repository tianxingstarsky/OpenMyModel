import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { getConfigDir } from "../config";
import { join } from "path";

import { mkdirSync } from "fs";

// ==================== 数据表定义 ====================

// API 密钥表
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),           // UUID
  name: text("name").notNull(),          // 密钥名称（用户自定义）
  key: text("key").notNull().unique(),   // 实际密钥 (sk-xxx)
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  totalTokens: integer("total_tokens").notNull().default(0),  // 累计 token
  totalRequests: integer("total_requests").notNull().default(0),
  monthlyTokens: integer("monthly_tokens").notNull().default(0),
  monthlyRequests: integer("monthly_requests").notNull().default(0),
  tokenLimit: integer("token_limit").default(0),   // 0 = 无限制
});

// 使用日志表
export const usageLogs = sqliteTable("usage_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  apiKeyId: text("api_key_id").notNull(),
  model: text("model").notNull(),
  endpoint: text("endpoint").notNull(),        // 如 /v1/chat/completions
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  timestamp: text("timestamp").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
});

// 连接节点表（记录哪些本地算力节点连接了）
export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),              // 节点 ID
  name: text("name").notNull(),             // 节点名称
  connectedAt: text("connected_at").notNull(),
  lastHeartbeat: text("last_heartbeat"),
  isOnline: integer("is_online", { mode: "boolean" }).notNull().default(false),
  modelName: text("model_name"),            // 当前加载的模型
  modelConfig: text("model_config"),        // JSON 模型配置
});

// ==================== 数据库初始化 ====================

export let db: BetterSQLite3Database;
let defaultDatabase: ReturnType<typeof createDatabase> | undefined;

export function initDatabase(): void {
  defaultDatabase ??= createDatabase(getConfigDir());
  db = defaultDatabase.db;
}

export function createDatabase(directory: string): { db: BetterSQLite3Database; sqlite: Database.Database; close: () => void } {
  mkdirSync(directory, { recursive: true });
  const sqlite = new Database(join(directory, "openmymodel.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_requests INTEGER NOT NULL DEFAULT 0,
      monthly_tokens INTEGER NOT NULL DEFAULT 0,
      monthly_requests INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_heartbeat TEXT,
      is_online INTEGER NOT NULL DEFAULT 0,
      model_name TEXT,
      model_config TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_models (
      id TEXT PRIMARY KEY,
      public_name TEXT NOT NULL UNIQUE,
      remark TEXT NOT NULL DEFAULT '',
      input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_routes (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      upstream_key TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      owner_user_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      token_limit INTEGER NOT NULL DEFAULT 0,
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      model_filter TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_requests INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS gateway_request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_usage_reservations (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reserved_cost REAL NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_token_reservations (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT,
      role TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      trade_no TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_balance_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      reference_id TEXT,
      description TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_logs(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_model_routes_model ON model_routes(model_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_gateway_keys_owner ON gateway_keys(owner_user_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_gateway_events_key_time ON gateway_request_events(key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_reservations_user_expiry ON provider_usage_reservations(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_gateway_token_reservations_key_expiry ON gateway_token_reservations(key_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry ON platform_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes(email, purpose, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_codes_created ON email_codes(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON payment_orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_balance_entries_user_time ON platform_balance_entries(user_id, created_at);
  `);
  try { sqlite.exec("ALTER TABLE usage_logs ADD COLUMN cost REAL NOT NULL DEFAULT 0"); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
  }
  const sessionUserId = (sqlite.pragma("table_info(platform_sessions)") as Array<{ name: string; notnull: number }>)
    .find(column => column.name === "user_id");
  if (sessionUserId?.notnull) {
    sqlite.transaction(() => {
      sqlite.exec(`DROP INDEX IF EXISTS idx_platform_sessions_expiry;
        ALTER TABLE platform_sessions RENAME TO platform_sessions_legacy;
        CREATE TABLE platform_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT,
          role TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO platform_sessions(token_hash, user_id, role, expires_at, created_at)
          SELECT token_hash, user_id, role, expires_at, created_at FROM platform_sessions_legacy;
        DROP TABLE platform_sessions_legacy;
        CREATE INDEX idx_platform_sessions_expiry ON platform_sessions(expires_at);`);
    })();
  }
  return { db: drizzle(sqlite), sqlite, close: () => sqlite.close() };
}
