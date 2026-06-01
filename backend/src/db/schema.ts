import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { getConfigDir } from "../config";
import { join } from "path";

const DB_PATH = join(getConfigDir(), "OpenMyModel.db");

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

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite);

export function initDatabase(): void {
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

    CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_logs(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
  `);
}