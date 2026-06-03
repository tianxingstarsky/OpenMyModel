#!/bin/sh
# Docker Entrypoint - 自动初始化配置
set -e

cd /app

CONFIG_FILE="/app/data/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  echo "============================================"
  echo "  OpenMyModel - 首次启动，自动初始化"
  echo "============================================"
  echo ""

  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="admin123456"
    echo "[WARN] 未设置 ADMIN_PASSWORD，使用默认密码: $ADMIN_PASSWORD"
  fi


  if [ -z "$PORT" ]; then
    PORT=3000
  fi

  node -e "
    const { createHash, randomBytes } = require('crypto');
    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(salt + '$ADMIN_PASSWORD').digest('hex');
    const config = {
      domain: '$DOMAIN',
      passwordHash: salt + ':' + hash,
      port: $PORT,
      setupComplete: true
    };
    require('fs').writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
  "

  echo "[OK] 配置已自动生成"
  echo "  域名: $DOMAIN"
  echo "  端口: $PORT"
  echo "  密码: $ADMIN_PASSWORD"
  echo ""
fi

exec node dist/index.js
