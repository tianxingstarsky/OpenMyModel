import { eq, and, sql } from "drizzle-orm";
import { db, apiKeys, usageLogs } from "../db/schema";
import { generateApiKey } from "./auth";
import { v4 as uuidv4 } from "uuid";

/**
 * API Key 管理器
 * - 生成、吊销、列出 API Key
 * - Key 用量统计
 */

export interface ApiKeyInfo {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt: string | null;
  isActive: boolean;
  totalTokens: number;
  totalRequests: number;
  monthlyTokens: number;
  monthlyRequests: number;
  tokenLimit: number;
}

export function createApiKey(name: string, tokenLimit: number = 0): ApiKeyInfo {
  const id = uuidv4();
  const key = generateApiKey();
  const now = new Date().toISOString();

  db.insert(apiKeys).values({
    id,
    name,
    key,
    createdAt: now,
    isActive: true,
    totalTokens: 0,
    totalRequests: 0,
    monthlyTokens: 0,
    monthlyRequests: 0,
    tokenLimit,
  }).run();

  return {
    id, name, key, createdAt: now, lastUsedAt: null,
    isActive: true, totalTokens: 0, totalRequests: 0,
    monthlyTokens: 0, monthlyRequests: 0, tokenLimit,
  };
}

export function revokeApiKey(id: string): boolean {
  const result = db.update(apiKeys)
    .set({ isActive: false })
    .where(eq(apiKeys.id, id))
    .run();
  return result.changes > 0;
}

export function listApiKeys(): ApiKeyInfo[] {
  const rows = db.select().from(apiKeys).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    key: r.key,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    isActive: r.isActive,
    totalTokens: r.totalTokens,
    totalRequests: r.totalRequests,
    monthlyTokens: r.monthlyTokens,
    monthlyRequests: r.monthlyRequests,
    tokenLimit: r.tokenLimit || 0,
  }));
}

export function validateApiKey(key: string): ApiKeyInfo | null {
  const rows = db.select().from(apiKeys)
    .where(and(eq(apiKeys.key, key), eq(apiKeys.isActive, true)))
    .all();
  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.id, name: r.name, key: r.key, createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt, isActive: r.isActive,
    totalTokens: r.totalTokens, totalRequests: r.totalRequests,
    monthlyTokens: r.monthlyTokens, monthlyRequests: r.monthlyRequests,
    tokenLimit: r.tokenLimit || 0,
  };
}

export function recordUsage(
  apiKeyId: string,
  model: string,
  endpoint: string,
  promptTokens: number,
  completionTokens: number,
  ip?: string,
  userAgent?: string,
): void {
  const now = new Date().toISOString();
  const totalTokens = promptTokens + completionTokens;

  // 插入使用日志
  db.insert(usageLogs).values({
    apiKeyId,
    model,
    endpoint,
    promptTokens,
    completionTokens,
    totalTokens,
    timestamp: now,
    ip: ip || null,
    userAgent: userAgent || null,
  }).run();

  // 更新统计
  const current = db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).all();
  if (current.length > 0) {
    const c = current[0];
    db.update(apiKeys)
      .set({
        lastUsedAt: now,
        totalTokens: (c.totalTokens || 0) + totalTokens,
        totalRequests: (c.totalRequests || 0) + 1,
        monthlyTokens: (c.monthlyTokens || 0) + totalTokens,
        monthlyRequests: (c.monthlyRequests || 0) + 1,
      })
      .where(eq(apiKeys.id, apiKeyId))
      .run();
  }
}

export function getUsageStats(apiKeyId?: string): any {
  if (apiKeyId) {
    return db.select().from(usageLogs)
      .where(eq(usageLogs.apiKeyId, apiKeyId))
      .orderBy(sql`timestamp DESC`)
      .limit(100)
      .all();
  }
  return db.select().from(usageLogs)
    .orderBy(sql`timestamp DESC`)
    .limit(100)
    .all();
}

export function resetMonthlyStats(): void {
  db.update(apiKeys)
    .set({ monthlyTokens: 0, monthlyRequests: 0 })
    .run();
}