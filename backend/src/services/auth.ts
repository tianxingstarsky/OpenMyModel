import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { ConfigStore, getConfigStore } from "../config";

const LEGACY_HASH = /^[a-f0-9]{32}:[a-f0-9]{64}$/i;
const SCRYPT_HASH = /^scrypt\$v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/i;
const validPassword = (password: unknown): password is string =>
  typeof password === "string" && password.length > 0 && Buffer.byteLength(password) <= 1024;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new Error("Password must contain 1 to 1024 UTF-8 bytes");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: unknown, storedHash: unknown): Promise<boolean> {
  if (!validPassword(password) || typeof storedHash !== "string") return false;
  const current = SCRYPT_HASH.exec(storedHash);
  if (current) return timingSafeEqual(await derive(password, current[1]), Buffer.from(current[2], "hex"));
  if (!LEGACY_HASH.test(storedHash)) return false;
  const [salt, hash] = storedHash.split(":");
  return timingSafeEqual(createHash("sha256").update(salt + password).digest(), Buffer.from(hash, "hex"));
}

export async function verifyAdminPassword(password: unknown, store = getConfigStore()): Promise<boolean> {
  const original = store.load().passwordHash;
  if (!await verifyPassword(password, original)) return false;
  if (LEGACY_HASH.test(original)) {
    const upgraded = await hashPassword(password as string);
    // A concurrent password reset must not be overwritten by a login migration.
    if (store.load().passwordHash === original) {
      store.save({ ...store.load(), passwordHash: upgraded });
      return true;
    }
  }
  return store.load().passwordHash === original || await verifyPassword(password, store.load().passwordHash);
}

export type AuthResult = "ok" | "invalid" | "limited";

export class AdminAuthenticator {
  private attempts = new Map<string, { count: number; until: number }>();
  private active = 0;

  constructor(private readonly store: ConfigStore, private readonly limit = 20, private readonly windowMs = 60000) {}

  async authenticate(password: unknown, address: string): Promise<AuthResult> {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    let entry = this.attempts.get(address);
    if (!entry) {
      if (this.attempts.size >= 10000) return "limited";
      entry = { count: 0, until: now + this.windowMs };
      this.attempts.set(address, entry);
    }
    if (entry.count >= this.limit || this.active >= 4) return "limited";
    entry.count++;
    this.active++;
    try {
      if (!await verifyAdminPassword(password, this.store)) return "invalid";
      entry.count--;
      return "ok";
    } finally {
      this.active--;
    }
  }
}

export function generateApiKey(): string {
  return `sk-oom-${randomBytes(32).toString("hex")}`;
}
