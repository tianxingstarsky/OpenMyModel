with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# 1. Add import for apiKeys table
old_imp = 'import { nodes, db } from "../db/schema";'
new_imp = 'import { nodes, db, apiKeys as apiKeysTable } from "../db/schema";'
c = c.replace(old_imp, new_imp)

# 2. Add sync helpers before class WebSocketTunnel
old_class = "\nclass WebSocketTunnel {"
helpers = '''
function syncApiKeys(keys) {
  const existingIds = new Set(db.select({id: apiKeysTable.id}).from(apiKeysTable).all().map(r => r.id));
  for (const k of keys) {
    if (existingIds.has(k.id)) {
      db.update(apiKeysTable).set({ name: k.name, key: k.key, isActive: k.isActive !== false, tokenLimit: k.tokenLimit || 0 })
        .where(eq(apiKeysTable.id, k.id)).run();
    } else {
      try {
        db.insert(apiKeysTable).values({
          id: k.id, name: k.name, key: k.key, createdAt: k.createdAt || new Date().toISOString(),
          isActive: k.isActive !== false, totalTokens: 0, totalRequests: 0,
          monthlyTokens: 0, monthlyRequests: 0, tokenLimit: k.tokenLimit || 0,
        }).run();
      } catch (_) {}
    }
  }
  const syncIds = new Set(keys.map(k => k.id));
  for (const id of existingIds) {
    if (!syncIds.has(id)) db.update(apiKeysTable).set({ isActive: false }).where(eq(apiKeysTable.id, id)).run();
  }
}
function getSyncedKeys() {
  return db.select().from(apiKeysTable).all();
}
'''
c = c.replace(old_class, helpers + old_class)

# 3. Replace empty sync_keys case
old_sync = 'case "sync_keys":\n              // 前端同步 API Key 数据\n              break;'
new_sync = '''case "sync_keys":
              if (msg.keys && Array.isArray(msg.keys)) {
                syncApiKeys(msg.keys);
                socket.send(JSON.stringify({ type: "keys_synced", keys: getSyncedKeys() }));
              }
              break;'''
c = c.replace(old_sync, new_sync)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)
print("sync_keys added to websocket.ts")
