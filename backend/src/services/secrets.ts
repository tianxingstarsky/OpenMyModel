import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const KEY_FILE = ".platform-key";

export function getPlatformSecret(directory: string): Buffer {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, KEY_FILE);
  if (!existsSync(path)) {
    const key = randomBytes(32);
    try { writeFileSync(path, key.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch (error) { if (!existsSync(path)) throw error; }
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid platform encryption key");
  return key;
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, ivHex, tagHex, ciphertext] = value.split(".");
  if (version !== "v1" || !ivHex || !tagHex || !ciphertext) throw new Error("Invalid encrypted platform secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function hashPlatformValue(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
