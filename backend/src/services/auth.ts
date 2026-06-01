import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getConfig } from "../config";

/**
 * 认证服务
 * - 密码哈希与验证（用于 WebSocket 连接认证）
 * - API Key 验证
 */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  const computed = createHash("sha256")
    .update(salt + password)
    .digest("hex");

  const bufA = Buffer.from(hash);
  const bufB = Buffer.from(computed);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyAdminPassword(password: string): boolean {
  const config = getConfig();
  if (!config.passwordHash) return false;
  return verifyPassword(password, config.passwordHash);
}

export function generateApiKey(): string {
  const randomPart = randomBytes(32).toString("hex");
  return `sk-oom-${randomPart}`;
}