import re

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# 1. Add imports for key sync
old_imp = 'import { eq } from "drizzle-orm";'
new_imp = '''import { eq } from "drizzle-orm";
import { apiKeys as apiKeysTable, db as dbRef } from "../db/schema";

function syncApiKeys(keys) {
  const existingIds = new Set(dbRef.select({id: apiKeysTable.id}).from(apiKeysTable).all().map(r => r.id));
  for (const k of keys) {
    if (existingIds.has(k.id)) {
      dbRef.update(apiKeysTable).set({
        name: k.name, key: k.key, isActive: k.isActive !== false,
        tokenLimit: k.tokenLimit || 0,
      }).where(eq(apiKeysTable.id, k.id)).run();
    } else {
      dbRef.insert(apiKeysTable).values({
        id: k.id, name: k.name, key: k.key, createdAt: k.createdAt || new Date().toISOString(),
        isActive: k.isActive !== false, totalTokens: 0, totalRequests: 0,
        monthlyTokens: 0, monthlyRequests: 0, tokenLimit: k.tokenLimit || 0,
      }).run();
    }
  }
  const syncIds = new Set(keys.map(k => k.id));
  for (const id of existingIds) {
    if (!syncIds.has(id)) {
      dbRef.update(apiKeysTable).set({ isActive: false }).where(eq(apiKeysTable.id, id)).run();
    }
  }
}

function listApiKeysLocal() {
  return dbRef.select().from(apiKeysTable).all().map(r => ({
    id: r.id, name: r.name, key: r.key, createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt, isActive: r.isActive,
    totalTokens: r.totalTokens, totalRequests: r.totalRequests,
    monthlyTokens: r.monthlyTokens, monthlyRequests: r.monthlyRequests,
    tokenLimit: r.tokenLimit || 0,
  }));
}
'''
c = c.replace(old_imp, new_imp)

# 2. Replace empty sync_keys handler
old_sync = 'case "sync_keys":\n              // 前端同步 API Key 数据\n              break;'
new_sync = '''case "sync_keys":
              if (msg.keys && Array.isArray(msg.keys)) {
                syncApiKeys(msg.keys);
                socket.send(JSON.stringify({
                  type: "keys_synced",
                  keys: listApiKeysLocal(),
                }));
              }
              break;'''
c = c.replace(old_sync, new_sync)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("websocket.ts patched")
