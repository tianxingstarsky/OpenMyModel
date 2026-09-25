import Database from "better-sqlite3";
import { createPrivateKey, createPublicKey, createSign, createVerify, randomInt, randomBytes, timingSafeEqual } from "crypto";
import { v4 as uuidv4 } from "uuid";
import nodemailer from "nodemailer";
import { WebSocketTunnel, RelayError } from "./websocket";
import { decryptSecret, encryptSecret, getPlatformSecret, hashPlatformValue } from "./secrets";

type Role = "admin" | "user";
type PlatformMode = "personal" | "provider" | "relay";
type RelayBillingMode = "free" | "monthly";
type Session = { role: Role; userId: string | null; email?: string };
type GatewayKey = {
  id: string; name: string; prefix: string; owner_user_id: string | null; token_limit: number;
  rpm_limit: number; model_filter: string; total_tokens: number; total_requests: number; service_mode: PlatformMode;
};
type ModelRoute = {
  id: string; model_id: string; public_name: string; node_id: string; upstream_model: string;
  upstream_key: string; node_api_key?: string | null; owner_user_id?: string | null;
  weight: number; enabled: number; input_price: number; output_price: number;
};

export class NodeKeyInUseError extends Error {
  constructor(readonly enabledRouteCount: number) {
    super(`此节点仍有 ${enabledRouteCount} 条启用路由依赖节点级 API Key，请先禁用或移除路由，或为路由保留独立兼容 Key`);
    this.name = "NodeKeyInUseError";
  }
}

export class NodeRemovalBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRemovalBlockedError";
  }
}

const isoNow = () => new Date().toISOString();
const DEFAULT_PROVIDER_MAX_TOKENS = 4096;
const MAX_PROVIDER_MAX_TOKENS = 65_536;
const PROVIDER_RESERVATION_MS = 15 * 60_000;
const TOKEN_RESERVATION_MS = 15 * 60_000;
const RESERVATION_RENEW_INTERVAL_MS = 5 * 60_000;
const validEmail = (value: unknown): value is string => typeof value === "string" && value.length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPublicUrl = (value: string, httpsOnly = false): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:"))
      && !!url.hostname && !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value);
  } catch { return false; }
};
const safeNumber = (value: unknown, label: string, min = 0, max = 1_000_000_000): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label} 超出有效范围`);
  return parsed;
};

function asPem(value: string, type: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const trimmed = value.trim();
  let key: ReturnType<typeof createPrivateKey> | ReturnType<typeof createPublicKey> | undefined;
  try {
    if (trimmed.includes("-----BEGIN ")) {
      key = type === "PRIVATE KEY" ? createPrivateKey(trimmed) : createPublicKey(trimmed);
    } else {
      const body = trimmed.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("invalid base64");
      const der = Buffer.from(body, "base64");
      if (!der.length || der.toString("base64").replace(/=+$/, "") !== body.replace(/=+$/, "")) throw new Error("invalid base64");
      if (type === "PRIVATE KEY") {
        for (const format of ["pkcs8", "pkcs1"] as const) {
          try { key = createPrivateKey({ key: der, format: "der", type: format }); break; }
          catch { /* Try the other standard RSA private-key encoding. */ }
        }
      } else {
        for (const format of ["spki", "pkcs1"] as const) {
          try { key = createPublicKey({ key: der, format: "der", type: format }); break; }
          catch { /* Try the other standard RSA public-key encoding. */ }
        }
      }
    }
    if (!key || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
      throw new Error("invalid RSA key");
    }
    return type === "PRIVATE KEY"
      ? (key as ReturnType<typeof createPrivateKey>).export({ format: "pem", type: "pkcs8" }).toString()
      : (key as ReturnType<typeof createPublicKey>).export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw new Error(type === "PRIVATE KEY" ? "应用私钥格式无效，需为 2048 位以上 RSA PEM 或 Base64" : "支付宝公钥格式无效，需为 2048 位以上 RSA PEM 或 Base64");
  }
}

export class PlatformService {
  private readonly secret: Buffer;
  private readonly routeCursors = new Map<string, number>();
  private readonly reservationLastRenewedAt = new Map<string, number>();
  private lastRelayEventPruneAt = 0;
  private relayAuthFailures = new Map<string, { count: number; until: number }>();

  constructor(readonly sqlite: Database.Database, readonly dataDir: string, readonly tunnel: WebSocketTunnel, private readonly publicUrl = "") {
    this.secret = getPlatformSecret(dataDir);
  }

  private setting(name: string): string {
    const row = this.sqlite.prepare("SELECT value FROM platform_settings WHERE key = ?").get(name) as { value: string } | undefined;
    return row?.value ?? "";
  }

  private setSetting(name: string, value: string): void {
    this.sqlite.prepare("INSERT INTO platform_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(name, value);
  }

  private secretSetting(name: string): string {
    const stored = this.setting(name);
    return stored ? decryptSecret(stored, this.secret) : "";
  }

  private configuredMode(): PlatformMode {
    const mode = this.setting("mode");
    return mode === "provider" || mode === "relay" ? mode : "personal";
  }

  getRelayBillingMode(): RelayBillingMode {
    return this.setting("relay_billing_mode") === "monthly" ? "monthly" : "free";
  }

  getPublicConfig(): { mode: PlatformMode; relayBillingMode: RelayBillingMode; serviceName: string } {
    const configured = this.configuredMode();
    const mode = configured === "provider" && !this.providerReady() || configured === "relay" && !this.relayReady()
      ? "personal" : configured;
    return { mode, relayBillingMode: this.getRelayBillingMode(), serviceName: this.setting("service_name") || "OpenMyModel" };
  }

  getAdminSettings() {
    return {
      ...this.getPublicConfig(), mode: this.configuredMode(), relayBillingMode: this.getRelayBillingMode(),
      relayMonthlyPrice: Number(this.setting("relay_monthly_price") || "0"),
      relayFreeMonthlyRequests: Number(this.setting("relay_free_monthly_requests") || "0"),
      relayMonthlyRequests: Number(this.setting("relay_monthly_requests") || "0"),
      publicUrl: this.setting("public_url") || this.publicUrl, currency: "CNY",
      mailHost: this.setting("mail_host"), mailPort: Number(this.setting("mail_port") || "465"), mailUser: this.setting("mail_user"),
      mailFrom: this.setting("mail_from"), mailPasswordSet: !!this.setting("mail_password"),
      alipayAppId: this.setting("alipay_app_id"), alipaySellerId: this.setting("alipay_seller_id"),
      alipayGateway: this.setting("alipay_gateway") || "https://openapi.alipay.com/gateway.do",
      alipayPrivateKeySet: !!this.setting("alipay_private_key"), alipayPublicKeySet: !!this.setting("alipay_public_key"),
      mailReady: this.mailReady(), alipayReady: this.alipayReady(), providerReady: this.providerReady(), relayReady: this.relayReady(),
    };
  }

  saveAdminSettings(input: Record<string, unknown>) {
    let transition: { from: PlatformMode; to: PlatformMode } | null = null;
    const result = this.sqlite.transaction(() => {
      const previousMode = this.configuredMode();
      const previousBillingMode = this.getRelayBillingMode();
      const textFields: Record<string, string> = {
        serviceName: "service_name", publicUrl: "public_url", mailHost: "mail_host", mailUser: "mail_user",
        mailFrom: "mail_from", alipayAppId: "alipay_app_id", alipaySellerId: "alipay_seller_id", alipayGateway: "alipay_gateway",
      };
      for (const [field, key] of Object.entries(textFields)) {
        if (input[field] !== undefined) this.setSetting(key, String(input[field]).trim().slice(0, 2048));
      }
      const publicUrl = this.setting("public_url");
      if (publicUrl && !validPublicUrl(publicUrl)) {
        throw new Error("公网地址必须是有效的 HTTP(S) 地址，且不能包含账号密码、查询参数或片段");
      }
      if (input.mailPort !== undefined) this.setSetting("mail_port", String(Math.round(safeNumber(input.mailPort, "SMTP 端口", 1, 65535))));
      const secretFields: Record<string, string> = {
        mailPassword: "mail_password", alipayPrivateKey: "alipay_private_key", alipayPublicKey: "alipay_public_key",
      };
      for (const [field, key] of Object.entries(secretFields)) {
        const value = input[field];
        if (typeof value === "string" && value.trim()) {
          const normalized = field === "alipayPrivateKey" ? asPem(value, "PRIVATE KEY")
            : field === "alipayPublicKey" ? asPem(value, "PUBLIC KEY") : value.trim();
          this.setSetting(key, encryptSecret(normalized, this.secret));
        }
      }
      if (input.relayBillingMode !== undefined) {
        if (input.relayBillingMode !== "free" && input.relayBillingMode !== "monthly") throw new Error("转发计费模式无效");
        this.setSetting("relay_billing_mode", input.relayBillingMode);
      }
      const numericSettings: Array<[string, string, string, number]> = [
        ["relayMonthlyPrice", "relay_monthly_price", "月度转发订阅价格", 1_000_000],
        ["relayFreeMonthlyRequests", "relay_free_monthly_requests", "免费转发月请求上限", 10_000_000],
        ["relayMonthlyRequests", "relay_monthly_requests", "订阅月请求上限", 10_000_000],
      ];
      for (const [field, key, label, maximum] of numericSettings) {
        if (input[field] === undefined) continue;
        const value = safeNumber(input[field], label, 0, maximum);
        if (!Number.isSafeInteger(value * (field === "relayMonthlyPrice" ? 100 : 1))) throw new Error(`${label}格式无效`);
        this.setSetting(key, field === "relayMonthlyPrice" ? (Math.round(value * 100) / 100).toFixed(2) : String(Math.floor(value)));
      }
      const requestedMode = input.mode === undefined ? previousMode : input.mode;
      if (requestedMode !== "personal" && requestedMode !== "provider" && requestedMode !== "relay") throw new Error("运营模式无效");
      const requestedBillingMode = this.getRelayBillingMode();
      if (previousMode === "relay" && requestedMode === "relay" && previousBillingMode !== requestedBillingMode) {
        const now = isoNow();
        const activePeriods = this.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_subscription_periods WHERE expires_at > ?")
          .get(now) as { count: number };
        const pendingOrders = this.sqlite.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE purpose='relay_subscription' AND status='pending'")
          .get() as { count: number };
        if (activePeriods.count || pendingOrders.count) {
          throw new Error("仍有有效订阅或待支付的转发订单，暂不能切换免费/订阅计费模式");
        }
      }
      if (previousMode === "provider" && requestedMode !== "provider") {
        const fundedUsers = this.sqlite.prepare("SELECT COUNT(*) AS count FROM platform_users WHERE balance > 0")
          .get() as { count: number };
        const pendingTopups = this.sqlite.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE purpose='topup' AND status='pending'")
          .get() as { count: number };
        const activeReservations = this.sqlite.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations WHERE expires_at > ?")
          .get(isoNow()) as { count: number };
        if (fundedUsers.count || pendingTopups.count || activeReservations.count) {
          throw new Error("仍有用户余额、待支付充值或进行中的计费请求；请先结算/处理后再切换运营模式，以免资金无法使用");
        }
      }
      if (previousMode === "relay" && requestedMode !== "relay") {
        const now = isoNow();
        const activePeriods = this.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_subscription_periods WHERE expires_at > ?")
          .get(now) as { count: number };
        const pendingOrders = this.sqlite.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE purpose='relay_subscription' AND status='pending'")
          .get() as { count: number };
        if (activePeriods.count || pendingOrders.count) {
          throw new Error("仍有有效的转发订阅或待支付订单，暂不能切换运营模式；请待订阅到期并处理待支付订单后重试");
        }
      }
      this.setSetting("mode", requestedMode);
      if (requestedMode === "provider" && !this.providerReady()) {
        throw new Error("启用服务商模式前，请配置 HTTPS 公网地址、邮箱 SMTP、支付宝应用 ID/商户 ID 和 RSA2 密钥");
      }
      if (requestedMode === "relay" && !this.relayReady()) {
        const needsAlipay = this.getRelayBillingMode() === "monthly";
        throw new Error(needsAlipay
          ? "启用月度订阅转发前，请配置 HTTPS 公网地址、完整邮箱 SMTP 和支付宝 RSA2 参数，并将订阅价格设为大于 0"
          : "启用免费转发前，请配置 HTTPS 公网地址和完整邮箱 SMTP 参数");
      }
      if (previousMode !== requestedMode) transition = { from: previousMode, to: requestedMode };
      return this.getAdminSettings();
    }).immediate();
    if (transition) {
      // A socket authenticated in one operating mode must never remain routable
      // after the mode changes. Nodes reconnect using the new mode's credential.
      for (const node of this.tunnel.getOnlineNodes()) this.tunnel.disconnectNode(node.id);
    }
    return result;
  }

  private mailReady(): boolean {
    return !!(this.setting("mail_host") && this.setting("mail_port") && this.setting("mail_user")
      && this.setting("mail_from") && this.setting("mail_password") && validPublicUrl(this.setting("public_url") || this.publicUrl, true));
  }

  private alipayReady(): boolean {
    return !!(this.setting("alipay_app_id") && this.setting("alipay_seller_id") && this.setting("alipay_private_key") && this.setting("alipay_public_key"));
  }

  private providerReady(): boolean { return this.mailReady() && this.alipayReady(); }

  private relayReady(): boolean {
    if (!this.mailReady()) return false;
    return this.getRelayBillingMode() === "free" || this.alipayReady() && Number(this.setting("relay_monthly_price")) > 0;
  }

  isProviderMode(): boolean { return this.configuredMode() === "provider" && this.providerReady(); }
  isRelayMode(): boolean { return this.configuredMode() === "relay" && this.relayReady(); }
  isUserPortalEnabled(): boolean { return this.isProviderMode() || this.isRelayMode(); }

  isUserActive(userId: string): boolean {
    const row = this.sqlite.prepare("SELECT is_active FROM platform_users WHERE id=?").get(userId) as { is_active: number } | undefined;
    return row?.is_active === 1;
  }

  createSession(role: Role, userId: string | null): string {
    this.sqlite.prepare("DELETE FROM platform_sessions WHERE expires_at <= ?").run(isoNow());
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.sqlite.prepare("INSERT INTO platform_sessions(token_hash, user_id, role, expires_at, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(hashPlatformValue(token, this.secret), userId, role, expires, isoNow());
    return token;
  }

  getSession(token: string | undefined): Session | null {
    if (!token || token.length > 256) return null;
    const row = this.sqlite.prepare(`SELECT s.role, s.user_id, u.email, u.is_active
      FROM platform_sessions s LEFT JOIN platform_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashPlatformValue(token, this.secret), isoNow()) as
      { role: Role; user_id: string | null; email?: string; is_active?: number } | undefined;
    if (!row || (row.role === "user" && row.is_active !== 1)) return null;
    return { role: row.role, userId: row.user_id, email: row.email };
  }

  revokeSession(token: string | undefined): void {
    if (token) this.sqlite.prepare("DELETE FROM platform_sessions WHERE token_hash = ?").run(hashPlatformValue(token, this.secret));
  }

  async sendEmailCode(emailInput: unknown, purposeInput: unknown): Promise<void> {
    if (!this.isUserPortalEnabled()) throw new Error("当前运营模式未开放用户账户");
    if (!validEmail(emailInput)) throw new Error("请输入有效邮箱地址");
    if (purposeInput !== "register" && purposeInput !== "login") throw new Error("验证码用途无效");
    const email = emailInput.trim().toLowerCase();
    const sendRequest = this.sqlite.transaction(() => {
      const user = this.sqlite.prepare("SELECT id, is_active FROM platform_users WHERE email = ?").get(email) as
        { id: string; is_active: number } | undefined;
      if ((purposeInput === "register" && user) || (purposeInput === "login" && (!user || user.is_active !== 1))) return null;

      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      this.sqlite.prepare("DELETE FROM email_codes WHERE created_at < ?").run(new Date(nowMs - 24 * 60 * 60_000).toISOString());
      const recent = this.sqlite.prepare("SELECT 1 FROM email_codes WHERE email = ? AND created_at >= ? LIMIT 1")
        .get(email, new Date(nowMs - 60_000).toISOString());
      const emailCount = this.sqlite.prepare("SELECT COUNT(*) AS count FROM email_codes WHERE email = ? AND created_at >= ?")
        .get(email, new Date(nowMs - 60 * 60_000).toISOString()) as { count: number };
      const globalCount = this.sqlite.prepare("SELECT COUNT(*) AS count FROM email_codes WHERE created_at >= ?")
        .get(new Date(nowMs - 60 * 60_000).toISOString()) as { count: number };
      if (recent || emailCount.count >= 5 || globalCount.count >= 200) return null;

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const id = uuidv4();
      this.sqlite.prepare("UPDATE email_codes SET consumed_at=? WHERE email=? AND purpose=? AND consumed_at IS NULL")
        .run(now, email, purposeInput);
      this.sqlite.prepare(`INSERT INTO email_codes(id, email, purpose, code_hash, expires_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?)`)
        .run(id, email, purposeInput, hashPlatformValue(`${email}\n${purposeInput}\n${code}`, this.secret),
          new Date(nowMs + 10 * 60_000).toISOString(), now);
      return { id, email, code };
    }).immediate();
    if (!sendRequest) return;

    const transporter = nodemailer.createTransport({
      host: this.setting("mail_host"), port: Number(this.setting("mail_port") || "465"),
      secure: Number(this.setting("mail_port") || "465") === 465,
      auth: { user: this.setting("mail_user"), pass: this.secretSetting("mail_password") },
      connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 15_000,
    });
    await transporter.sendMail({
      from: this.setting("mail_from"), to: sendRequest.email,
      subject: `${this.setting("service_name") || "OpenMyModel"} 邮箱验证码`,
      text: `你的验证码是 ${sendRequest.code}，10 分钟内有效。若非本人操作，请忽略此邮件。`,
      html: `<div style="font-family:Arial,sans-serif;color:#1f2937"><h2>${escapeHtml(this.setting("service_name") || "OpenMyModel")}</h2><p>你的邮箱验证码：</p><p style="font-size:30px;font-weight:700;letter-spacing:8px;color:#087f6e">${sendRequest.code}</p><p>10 分钟内有效。若非本人操作，请忽略此邮件。</p></div>`,
    });
  }

  async sendTestEmail(emailInput: unknown): Promise<void> {
    if (!validEmail(emailInput)) throw new Error("请输入有效的收件邮箱");
    if (!this.setting("mail_host") || !this.setting("mail_user") || !this.setting("mail_from") || !this.setting("mail_password")) {
      throw new Error("请先填写并保存完整的 SMTP 配置");
    }
    const port = Number(this.setting("mail_port") || "465");
    const transporter = nodemailer.createTransport({ host: this.setting("mail_host"), port, secure: port === 465,
      auth: { user: this.setting("mail_user"), pass: this.secretSetting("mail_password") },
      connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 15_000 });
    await transporter.sendMail({ from: this.setting("mail_from"), to: emailInput.trim(),
      subject: `${this.setting("service_name") || "OpenMyModel"} 邮件配置测试`, text: "邮件服务配置成功，可以发送登录验证码。" });
  }

  loginWithCode(emailInput: unknown, purpose: "register" | "login", codeInput: unknown): { token: string; userId: string; email: string } {
    if (!this.isUserPortalEnabled()) throw new Error("当前运营模式未开放用户账户");
    if (!validEmail(emailInput) || typeof codeInput !== "string" || !/^\d{6}$/.test(codeInput)) throw new Error("邮箱或验证码格式无效");
    const email = emailInput.trim().toLowerCase();
    const result = this.sqlite.transaction(() => {
      if (!this.isUserPortalEnabled()) return { error: "当前运营模式未开放用户账户" };
      const row = this.sqlite.prepare(`SELECT id, code_hash, attempts FROM email_codes
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
        .get(email, purpose, isoNow()) as { id: string; code_hash: string; attempts: number } | undefined;
      if (!row || row.attempts >= 5) return { error: "验证码无效或已过期" };
      const incremented = this.sqlite.prepare(`UPDATE email_codes SET attempts = attempts + 1
        WHERE id = ? AND consumed_at IS NULL AND attempts < 5`).run(row.id);
      if (!incremented.changes) return { error: "验证码无效或已过期" };
      const actual = Buffer.from(hashPlatformValue(`${email}\n${purpose}\n${codeInput}`, this.secret), "hex");
      const expected = Buffer.from(row.code_hash, "hex");
      if (!timingSafeEqual(actual, expected)) return { error: "验证码无效或已过期" };
      const consumed = this.sqlite.prepare("UPDATE email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
        .run(isoNow(), row.id);
      if (!consumed.changes) return { error: "验证码无效或已过期" };

      let user = this.sqlite.prepare("SELECT id, is_active FROM platform_users WHERE email = ?")
        .get(email) as { id: string; is_active: number } | undefined;
      if (purpose === "register") {
        if (user) return { error: "此邮箱已注册，请直接登录" };
        const id = uuidv4();
        this.sqlite.prepare("INSERT INTO platform_users(id, email, created_at) VALUES(?, ?, ?)").run(id, email, isoNow());
        user = { id, is_active: 1 };
      } else if (!user) return { error: "验证码无效或已过期" };
      if (!user || user.is_active !== 1) return { error: "此账号已停用，请联系管理员" };
      this.sqlite.prepare("UPDATE platform_users SET last_login_at = ? WHERE id = ?").run(isoNow(), user.id);
      return { token: this.createSession("user", user.id), userId: user.id, email };
    }).immediate();
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  createRelayNode(userId: string, nameInput: unknown) {
    if (!this.isRelayMode()) throw new Error("当前服务未开放个人节点接入");
    const name = typeof nameInput === "string" ? nameInput.trim().slice(0, 80) : "";
    if (!name || /[\0\r\n]/.test(name)) throw new Error("节点名称需为 1–80 个有效字符");
    const id = uuidv4();
    const nodeId = uuidv4();
    const token = `omm-relay-node-${randomBytes(32).toString("base64url")}`;
    const now = isoNow();
    const create = this.sqlite.transaction(() => {
      const user = this.sqlite.prepare("SELECT is_active FROM platform_users WHERE id=?").get(userId) as { is_active: number } | undefined;
      if (!user || user.is_active !== 1) throw new Error("账号已停用");
      const activeCount = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM relay_node_credentials
        WHERE user_id=? AND revoked_at IS NULL`).get(userId) as { count: number };
      if (activeCount.count >= 10) throw new Error("每个账户最多接入 10 个有效节点");
      this.sqlite.prepare(`INSERT INTO relay_node_credentials(id,user_id,node_id,name,token_hash,created_at)
        VALUES(?,?,?,?,?,?)`).run(id, userId, nodeId, name, hashPlatformValue(token, this.secret), now);
      this.sqlite.prepare(`INSERT INTO nodes(id,name,connected_at,is_online,model_name,model_config,owner_user_id)
        VALUES(?,?,?,0,'','',?)`).run(nodeId, name, now, userId);
    });
    create.immediate();
    return { id, nodeId, name, token, createdAt: now };
  }

  authenticateRelayNodeToken(tokenInput: unknown, address: string):
    | "invalid" | "limited" | { status: "ok"; ownerUserId: string; nodeId: string; nodeName: string } {
    const now = Date.now();
    for (const [key, value] of this.relayAuthFailures) if (value.until <= now) this.relayAuthFailures.delete(key);
    const failure = this.relayAuthFailures.get(address);
    if (failure && failure.count >= 30) return "limited";
    if (!this.isRelayMode() || typeof tokenInput !== "string" || tokenInput.length > 256) return "invalid";
    const token = tokenInput.trim();
    if (!token.startsWith("omm-relay-node-") || token.length < 40) return "invalid";
    const row = this.sqlite.prepare(`SELECT c.id,c.user_id AS userId,c.node_id AS nodeId,c.name AS nodeName
      FROM relay_node_credentials c JOIN platform_users u ON u.id=c.user_id
      WHERE c.token_hash=? AND c.revoked_at IS NULL AND u.is_active=1`).get(hashPlatformValue(token, this.secret)) as
      { id: string; userId: string; nodeId: string; nodeName: string } | undefined;
    if (!row) {
      const current = this.relayAuthFailures.get(address);
      this.relayAuthFailures.set(address, { count: (current?.count ?? 0) + 1, until: current?.until ?? now + 60_000 });
      return this.relayAuthFailures.get(address)!.count >= 30 ? "limited" : "invalid";
    }
    this.relayAuthFailures.delete(address);
    this.sqlite.prepare("UPDATE relay_node_credentials SET last_seen_at=? WHERE id=? AND revoked_at IS NULL")
      .run(isoNow(), row.id);
    return { status: "ok", ownerUserId: row.userId, nodeId: row.nodeId, nodeName: row.nodeName };
  }

  listRelayNodes(userId: string) {
    const online = new Map(this.tunnel.getOnlineNodes().filter(node => node.ownerUserId === userId).map(node => [node.id, node]));
    const rows = this.sqlite.prepare(`SELECT c.id,c.node_id AS nodeId,c.name,c.created_at AS createdAt,c.last_seen_at AS lastSeenAt,
      c.revoked_at AS revokedAt,n.connected_at AS connectedAt,n.last_heartbeat AS lastHeartbeat,
      n.model_name AS modelName,n.is_online AS storedOnline
      FROM relay_node_credentials c LEFT JOIN nodes n ON n.id=c.node_id WHERE c.user_id=? AND c.revoked_at IS NULL
      ORDER BY c.created_at DESC`).all(userId) as Array<Record<string, any>>;
    return rows.map(row => {
      const live = online.get(row.nodeId);
      return { id: row.id, nodeId: row.nodeId, name: row.name, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt,
        connectedAt: live ? row.connectedAt : null, lastHeartbeat: live ? row.lastHeartbeat : null,
        modelName: live?.modelName || row.modelName || "", isOnline: !!live, serverRunning: !!live?.serverRunning,
        slots: live?.slots ?? null };
    });
  }

  rotateRelayNodeToken(userId: string, nodeId: string) {
    const credential = this.sqlite.prepare(`SELECT id,name FROM relay_node_credentials
      WHERE user_id=? AND node_id=? AND revoked_at IS NULL`).get(userId, nodeId) as { id: string; name: string } | undefined;
    if (!credential) throw new Error("节点不存在或已撤销");
    const token = `omm-relay-node-${randomBytes(32).toString("base64url")}`;
    this.sqlite.prepare("UPDATE relay_node_credentials SET token_hash=?,last_seen_at=NULL WHERE id=? AND revoked_at IS NULL")
      .run(hashPlatformValue(token, this.secret), credential.id);
    this.tunnel.disconnectNode(nodeId);
    return { nodeId, name: credential.name, token };
  }

  revokeRelayNode(userId: string, nodeId: string): boolean {
    const now = isoNow();
    const revoke = this.sqlite.transaction(() => {
      const credential = this.sqlite.prepare(`SELECT id FROM relay_node_credentials
        WHERE user_id=? AND node_id=? AND revoked_at IS NULL`).get(userId, nodeId) as { id: string } | undefined;
      if (!credential) return false;
      this.sqlite.prepare("UPDATE relay_node_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
        .run(now, credential.id);
      this.sqlite.prepare("UPDATE nodes SET is_online=0 WHERE id=? AND owner_user_id=?").run(nodeId, userId);
      this.sqlite.prepare("DELETE FROM relay_model_routes WHERE user_id=? AND node_id=?").run(userId, nodeId);
      return true;
    });
    const removed = revoke.immediate();
    if (removed) this.tunnel.disconnectNode(nodeId);
    return removed;
  }

  saveModel(input: Record<string, unknown>) {
    if (this.isRelayMode()) throw new Error("代转发模式下模型与节点路由由每位用户自行管理");
    const name = typeof input.publicName === "string" ? input.publicName.trim() : "";
    const remark = typeof input.remark === "string" ? input.remark.trim().slice(0, 300) : "";
    if (!name || name.length > 128 || /[\r\n]/.test(name)) throw new Error("模型公开名称需为 1–128 个字符");
    const inputPrice = safeNumber(input.inputPrice, "输入单价", 0, 1_000_000);
    const outputPrice = safeNumber(input.outputPrice, "输出单价", 0, 1_000_000);
    const enabled = input.enabled !== false;
    const id = typeof input.id === "string" && input.id ? input.id : uuidv4();
    this.sqlite.prepare(`INSERT INTO platform_models(id, public_name, remark, input_price, output_price, enabled, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET public_name=excluded.public_name, remark=excluded.remark,
      input_price=excluded.input_price, output_price=excluded.output_price, enabled=excluded.enabled`)
      .run(id, name, remark, inputPrice, outputPrice, enabled ? 1 : 0, isoNow());
    return this.adminModels().find(model => model.id === id);
  }

  deleteModel(id: string): void {
    if (this.isRelayMode()) throw new Error("代转发模式下不能删除用户模型路由");
    this.routeCursors.delete(id);
    this.sqlite.prepare("DELETE FROM model_routes WHERE model_id = ?").run(id);
    this.sqlite.prepare("DELETE FROM platform_models WHERE id = ?").run(id);
  }

  saveRoute(input: Record<string, unknown>) {
    if (this.isRelayMode()) throw new Error("代转发模式下不能创建平台共享节点路由");
    const id = typeof input.id === "string" && input.id ? input.id : uuidv4();
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
    const upstreamModel = typeof input.upstreamModel === "string" ? input.upstreamModel.trim() : "";
    const previous = this.sqlite.prepare("SELECT upstream_key FROM model_routes WHERE id = ?").get(id) as { upstream_key: string } | undefined;
    const upstreamKey = typeof input.upstreamKey === "string" && input.upstreamKey.trim()
      ? encryptSecret(input.upstreamKey.trim(), this.secret) : previous?.upstream_key || "";
    const nodeKey = this.sqlite.prepare("SELECT upstream_api_key,owner_user_id AS ownerUserId FROM nodes WHERE id=?").get(nodeId) as
      { upstream_api_key: string | null; ownerUserId: string | null } | undefined;
    if (nodeKey?.ownerUserId) throw new Error("个人代转发节点不能加入平台共享路由");
    if (!modelId || !nodeId || !upstreamModel || (!upstreamKey && !nodeKey?.upstream_api_key) || upstreamModel.length > 256 || /[\r\n]/.test(upstreamModel)
      || (typeof input.upstreamKey === "string" && (input.upstreamKey.length > 4096 || /[\r\n]/.test(input.upstreamKey)))) {
      throw new Error("请选择模型和节点，填写节点实际模型名，并先在节点管理中配置该节点的 llama-server API Key");
    }
    if (!this.sqlite.prepare("SELECT id FROM platform_models WHERE id = ?").get(modelId)) throw new Error("模型不存在");
    const weight = Math.round(safeNumber(input.weight ?? 1, "调度权重", 1, 100));
    const enabled = input.enabled !== false;
    this.sqlite.prepare(`INSERT INTO model_routes(id, model_id, node_id, upstream_model, upstream_key, weight, enabled, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model_id=excluded.model_id, node_id=excluded.node_id,
      upstream_model=excluded.upstream_model, upstream_key=excluded.upstream_key, weight=excluded.weight, enabled=excluded.enabled`)
      .run(id, modelId, nodeId, upstreamModel, upstreamKey, weight, enabled ? 1 : 0, isoNow());
    return this.adminModels().find(model => model.id === modelId);
  }

  deleteRoute(id: string): void {
    if (this.isRelayMode()) throw new Error("代转发模式下不能删除平台共享节点路由");
    this.sqlite.prepare("DELETE FROM model_routes WHERE id = ?").run(id);
  }

  saveRelayModel(userId: string, input: Record<string, unknown>) {
    if (!this.isRelayMode()) throw new Error("当前服务未开放代转发模型管理");
    const name = typeof input.publicName === "string" ? input.publicName.trim() : "";
    const remark = typeof input.remark === "string" ? input.remark.trim().slice(0, 300) : "";
    if (!name || name.length > 128 || /[\0\r\n]/.test(name)) throw new Error("公开模型名需为 1–128 个有效字符");
    const enabled = input.enabled !== false;
    const id = typeof input.id === "string" && input.id ? input.id : uuidv4();
    const previous = this.sqlite.prepare("SELECT user_id FROM relay_models WHERE id=?").get(id) as { user_id: string } | undefined;
    if (previous && previous.user_id !== userId) throw new Error("模型不存在");
    try {
      this.sqlite.prepare(`INSERT INTO relay_models(id,user_id,public_name,remark,enabled,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET public_name=excluded.public_name,remark=excluded.remark,enabled=excluded.enabled
        WHERE relay_models.user_id=excluded.user_id`).run(id, userId, name, remark, enabled ? 1 : 0, isoNow());
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("此账户已存在同名公开模型");
      throw error;
    }
    return this.listRelayModels(userId).find(model => model.id === id);
  }

  deleteRelayModel(userId: string, modelId: string): boolean {
    const remove = this.sqlite.transaction(() => {
      const owned = this.sqlite.prepare("SELECT id FROM relay_models WHERE id=? AND user_id=?").get(modelId, userId);
      if (!owned) return false;
      this.sqlite.prepare("DELETE FROM relay_model_routes WHERE model_id=? AND user_id=?").run(modelId, userId);
      this.sqlite.prepare("DELETE FROM relay_models WHERE id=? AND user_id=?").run(modelId, userId);
      return true;
    });
    this.routeCursors.delete(`relay:${userId}:${modelId}`);
    return remove.immediate();
  }

  saveRelayModelRoute(userId: string, modelIdInput: string, input: Record<string, unknown>) {
    if (!this.isRelayMode()) throw new Error("当前服务未开放代转发路由管理");
    const modelId = typeof modelIdInput === "string" ? modelIdInput : "";
    const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
    const upstreamModel = typeof input.upstreamModel === "string" ? input.upstreamModel.trim() : "";
    if (!this.sqlite.prepare("SELECT id FROM relay_models WHERE id=? AND user_id=?").get(modelId, userId)) throw new Error("模型不存在");
    if (!this.sqlite.prepare(`SELECT id FROM relay_node_credentials WHERE node_id=? AND user_id=? AND revoked_at IS NULL`)
      .get(nodeId, userId)) throw new Error("只能为当前账户已接入的节点添加路由");
    if (!nodeId || !upstreamModel || upstreamModel.length > 256 || /[\0\r\n]/.test(upstreamModel)) {
      throw new Error("请选择个人节点并填写节点上的实际模型名");
    }
    const id = typeof input.id === "string" && input.id ? input.id : uuidv4();
    const previous = this.sqlite.prepare("SELECT user_id FROM relay_model_routes WHERE id=?").get(id) as { user_id: string } | undefined;
    if (previous && previous.user_id !== userId) throw new Error("路由不存在");
    const weight = Math.floor(safeNumber(input.weight ?? 1, "调度权重", 1, 100));
    const enabled = input.enabled !== false;
    try {
      this.sqlite.prepare(`INSERT INTO relay_model_routes(id,user_id,model_id,node_id,upstream_model,weight,enabled,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model_id=excluded.model_id,node_id=excluded.node_id,
        upstream_model=excluded.upstream_model,weight=excluded.weight,enabled=excluded.enabled
        WHERE relay_model_routes.user_id=excluded.user_id`).run(id, userId, modelId, nodeId, upstreamModel, weight,
        enabled ? 1 : 0, isoNow());
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("该模型路由已存在");
      throw error;
    }
    return this.listRelayModels(userId).find(model => model.id === modelId);
  }

  deleteRelayModelRoute(userId: string, routeId: string): boolean {
    return this.sqlite.prepare("DELETE FROM relay_model_routes WHERE id=? AND user_id=?").run(routeId, userId).changes > 0;
  }

  listRelayModels(userId: string): Array<{
    id: string; publicName: string; remark: string; enabled: boolean; createdAt: string;
    routes: Array<{
      id: string; modelId: string; nodeId: string; upstreamModel: string; weight: number;
      enabled: boolean; nodeName: string; nodeOnline: boolean; serverRunning: boolean; nodeModel: string;
    }>;
  }> {
    const online = new Map(this.tunnel.getOnlineNodes().filter(node => node.ownerUserId === userId).map(node => [node.id, node]));
    const models = this.sqlite.prepare(`SELECT id,public_name AS publicName,remark,enabled,created_at AS createdAt
      FROM relay_models WHERE user_id=? ORDER BY public_name COLLATE NOCASE`).all(userId) as Array<Record<string, any>>;
    const routes = this.sqlite.prepare(`SELECT r.id,r.model_id AS modelId,r.node_id AS nodeId,r.upstream_model AS upstreamModel,
      r.weight,r.enabled,c.name AS nodeName FROM relay_model_routes r JOIN relay_node_credentials c ON c.node_id=r.node_id
      WHERE r.user_id=? AND c.user_id=? AND c.revoked_at IS NULL ORDER BY r.weight DESC,r.id`)
      .all(userId, userId) as Array<Record<string, any>>;
    return models.map(model => ({
      id: String(model.id), publicName: String(model.publicName), remark: String(model.remark || ""),
      createdAt: String(model.createdAt), enabled: model.enabled === 1,
      routes: routes.filter(route => route.modelId === model.id).map(route => {
        const live = online.get(route.nodeId);
        return {
          id: String(route.id), modelId: String(route.modelId), nodeId: String(route.nodeId),
          upstreamModel: String(route.upstreamModel), weight: Number(route.weight), enabled: route.enabled === 1,
          nodeName: String(route.nodeName), nodeOnline: !!live, serverRunning: !!live?.serverRunning,
          nodeModel: live?.modelName || "",
        };
      }) }));
  }

  publicRelayModels(userId: string, modelFilter: string[] = []): Array<{ id: string; object: string; owned_by: string }> {
    const available = new Set(this.tunnel.getOnlineNodes().filter(node => node.ownerUserId === userId && node.serverRunning).map(node => node.id));
    if (!available.size) return [];
    const nodePlaceholders = [...available].map(() => "?").join(",");
    const rows = this.sqlite.prepare(`SELECT DISTINCT m.public_name AS publicName FROM relay_models m
      JOIN relay_model_routes r ON r.model_id=m.id AND r.user_id=m.user_id
      JOIN relay_node_credentials c ON c.node_id=r.node_id AND c.user_id=m.user_id
      WHERE m.user_id=? AND m.enabled=1 AND r.enabled=1 AND c.revoked_at IS NULL
        AND r.node_id IN (${nodePlaceholders}) ORDER BY m.public_name COLLATE NOCASE`)
      .all(userId, ...available) as Array<{ publicName: string }>;
    return rows.filter(row => !modelFilter.length || modelFilter.includes(row.publicName))
      .map(row => ({ id: row.publicName, object: "model", owned_by: this.getPublicConfig().serviceName }));
  }

  async selectRelayRoute(userId: string, modelName: string, signal?: AbortSignal): Promise<{
    nodeId: string; connectionId: string; upstreamModel: string; publicName: string; inputPrice: number; outputPrice: number;
  }> {
    const rows = this.sqlite.prepare(`SELECT r.id,r.node_id AS nodeId,r.upstream_model AS upstreamModel,r.weight,
      m.id AS modelId,m.public_name AS publicName FROM relay_models m JOIN relay_model_routes r ON r.model_id=m.id AND r.user_id=m.user_id
      JOIN relay_node_credentials c ON c.node_id=r.node_id AND c.user_id=m.user_id
      WHERE m.user_id=? AND m.public_name=? COLLATE NOCASE AND m.enabled=1 AND r.enabled=1 AND c.revoked_at IS NULL
      ORDER BY r.weight DESC,r.id`).all(userId, modelName) as Array<Record<string, any>>;
    if (!rows.length) throw new RelayError("Requested model is not available for this account", 404);
    const online = new Map(this.tunnel.getOnlineNodes()
      .filter(node => node.ownerUserId === userId && node.serverRunning).map(node => [node.id, node]));
    let candidates = rows.filter(row => online.has(row.nodeId));
    if (!candidates.length) throw new RelayError("Your model nodes are offline or still loading", 503);
    const cursorKey = `relay:${userId}:${candidates[0].modelId}`;
    const weightOf = (route: Record<string, any>) => Number.isSafeInteger(route.weight) ? Math.max(1, Math.min(route.weight, 100)) : 1;
    const totalWeight = candidates.reduce((sum, route) => sum + weightOf(route), 0);
    const ticket = (this.routeCursors.get(cursorKey) ?? 0) % totalWeight;
    this.routeCursors.set(cursorKey, (ticket + 1) % totalWeight);
    let cumulative = 0;
    const selected = candidates.find(route => (cumulative += weightOf(route)) > ticket)!;
    candidates = [selected, ...candidates.filter(route => route.id !== selected.id)];
    let lastError: unknown;
    for (const route of candidates) {
      if (signal?.aborted) throw new RelayError("HTTP client disconnected", 499);
      try {
        const target = this.tunnel.routeToNode(route.nodeId);
        return { ...target, upstreamModel: route.upstreamModel, publicName: route.publicName, inputPrice: 0, outputPrice: 0 };
      } catch (error) { lastError = error; }
    }
    throw new RelayError(lastError instanceof Error ? "Your model node is unavailable" : "Requested model is not available", 503);
  }

  adminModels() {
    const online = new Map(this.tunnel.getOnlineNodes().map(node => [node.id, node]));
    const knownNodes = new Map((this.sqlite.prepare("SELECT id, name, model_name AS modelName FROM nodes").all() as Array<Record<string, any>>)
      .map(node => [node.id, node]));
    const models = this.sqlite.prepare("SELECT * FROM platform_models ORDER BY public_name COLLATE NOCASE").all() as Array<Record<string, any>>;
    const routes = this.sqlite.prepare("SELECT * FROM model_routes ORDER BY weight DESC").all() as Array<Record<string, any>>;
    const nodeKeys = new Map((this.sqlite.prepare("SELECT id, upstream_api_key FROM nodes").all() as Array<{ id: string; upstream_api_key: string | null }>)
      .map(node => [node.id, node.upstream_api_key]));
    return models.map(model => ({
      id: model.id, publicName: model.public_name, remark: model.remark,
      inputPrice: model.input_price, outputPrice: model.output_price, enabled: model.enabled === 1,
      routes: routes.filter(route => route.model_id === model.id).map(route => {
        const liveNode = online.get(route.node_id);
        const node = liveNode || knownNodes.get(route.node_id);
        return { id: route.id, nodeId: route.node_id, nodeName: node?.name || route.node_id, nodeModel: node?.modelName || "",
          nodeOnline: !!liveNode?.serverRunning, upstreamModel: route.upstream_model, weight: route.weight,
          enabled: route.enabled === 1, keyConfigured: !!nodeKeys.get(route.node_id) || !!route.upstream_key,
          keySource: nodeKeys.get(route.node_id) ? "node" : route.upstream_key ? "route" : "missing" };
      }),
    }));
  }

  publicModels(modelFilter: string[] = []): Array<{ id: string; object: string; owned_by: string }> {
    const available = new Set(this.tunnel.getOnlineNodes().filter(node => node.serverRunning).map(node => node.id));
    const rows = this.sqlite.prepare(`SELECT m.public_name, r.node_id FROM platform_models m JOIN model_routes r ON r.model_id=m.id
      LEFT JOIN nodes n ON n.id=r.node_id
      WHERE m.enabled=1 AND r.enabled=1 AND (COALESCE(n.upstream_api_key,'')<>'' OR r.upstream_key<>'')`)
      .all() as Array<{ public_name: string; node_id: string }>;
    const names = new Set(rows.filter(row => available.has(row.node_id) &&
      (!modelFilter.length || modelFilter.includes(row.public_name))).map(row => row.public_name));
    return [...names].sort((a, b) => a.localeCompare(b)).map(name =>
      ({ id: name, object: "model", owned_by: this.getPublicConfig().serviceName }));
  }

  async selectManagedRoute(modelName: string, signal?: AbortSignal): Promise<{ nodeId: string; connectionId: string; upstreamModel: string; upstreamKey: string; publicName: string; inputPrice: number; outputPrice: number }> {
    const rows = this.sqlite.prepare(`SELECT r.*, n.upstream_api_key AS node_api_key, n.owner_user_id AS owner_user_id,
      m.public_name, m.input_price, m.output_price FROM model_routes r
      JOIN platform_models m ON m.id=r.model_id LEFT JOIN nodes n ON n.id=r.node_id
      WHERE m.public_name=? AND m.enabled=1 AND r.enabled=1 ORDER BY r.weight DESC, r.id ASC`)
      .all(modelName) as ModelRoute[];
    const online = new Set(this.tunnel.getOnlineNodes().filter(node => node.serverRunning).map(node => node.id));
    let candidates = rows.filter(row => online.has(row.node_id) && !row.owner_user_id && !!(row.node_api_key || row.upstream_key));
    if (!candidates.length) throw new RelayError("Requested model is not available", 404);
    const routeWeight = (route: ModelRoute) => Number.isSafeInteger(route.weight)
      ? Math.max(1, Math.min(route.weight, 100)) : 1;
    const totalWeight = candidates.reduce((sum, route) => sum + routeWeight(route), 0);
    const modelId = candidates[0].model_id;
    const ticket = (this.routeCursors.get(modelId) ?? 0) % totalWeight;
    this.routeCursors.set(modelId, (ticket + 1) % totalWeight);
    let cumulative = 0;
    const selected = candidates.find(route => (cumulative += routeWeight(route)) > ticket)!;
    candidates = [selected, ...candidates.filter(route => route.id !== selected.id)];
    let lastError: unknown;
    for (const route of candidates) {
      if (signal?.aborted) throw new RelayError("HTTP client disconnected", 499);
      try {
        const target = this.tunnel.routeToNode(route.node_id);
        const encryptedKey = route.node_api_key || route.upstream_key;
        return { ...target, upstreamModel: route.upstream_model, upstreamKey: encryptedKey ? decryptSecret(encryptedKey, this.secret) : "",
          publicName: route.public_name, inputPrice: route.input_price, outputPrice: route.output_price };
      } catch (error) { lastError = error; }
    }
    if (lastError instanceof Error) throw new RelayError("No configured compute node accepted its upstream key", 503);
    throw new RelayError("Requested model is not available", 404);
  }

  createGatewayKey(nameInput: unknown, ownerUserId: string | null = null, tokenLimitInput: unknown = 0, rpmInput: unknown = 0,
    modelFilterInput: unknown = []) {
    const name = typeof nameInput === "string" ? nameInput.trim().slice(0, 80) : "";
    if (!name) throw new Error("密钥名称不能为空");
    if (this.isUserPortalEnabled() && ownerUserId === null) throw new Error("账户模式下 API Key 必须关联用户账户");
    if (!this.isUserPortalEnabled() && ownerUserId !== null) throw new Error("当前模式不支持用户 API Key");
    const tokenLimit = Math.floor(safeNumber(tokenLimitInput, "Token 限额", 0, 1_000_000_000_000));
    const rpmLimit = Math.floor(safeNumber(rpmInput, "每分钟请求上限", 0, 100_000));
    const modelFilter = this.normalizeModelFilter(modelFilterInput, ownerUserId);
    const serviceMode: PlatformMode = ownerUserId === null ? "personal" : this.isRelayMode() ? "relay" : "provider";
    const id = uuidv4();
    const raw = `sk-oom-gw-${randomBytes(32).toString("hex")}`;
    const prefix = raw.slice(0, 17);
    const createdAt = isoNow();
    this.sqlite.prepare(`INSERT INTO gateway_keys(id, name, prefix, secret_hash, owner_user_id, service_mode, token_limit, rpm_limit, model_filter, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, prefix, hashPlatformValue(raw, this.secret), ownerUserId, serviceMode, tokenLimit, rpmLimit, JSON.stringify(modelFilter), createdAt);
    return { id, name, key: raw, prefix, tokenLimit, rpmLimit, modelFilter, serviceMode, createdAt };
  }

  findGatewayKey(raw: string): GatewayKey | null {
    const row = this.sqlite.prepare("SELECT * FROM gateway_keys WHERE secret_hash = ? AND is_active=1")
      .get(hashPlatformValue(raw, this.secret)) as GatewayKey | undefined;
    return row ?? null;
  }

  directKeyId(raw: string): string {
    return `direct-${hashPlatformValue(`direct-key\n${raw}`, this.secret).slice(0, 40)}`;
  }

  checkGatewayKey(key: GatewayKey, options: { countRelayRequest?: boolean } = {}): void {
    const now = isoNow();
    const reserve = this.sqlite.transaction(() => {
      const current = this.sqlite.prepare(`SELECT owner_user_id, service_mode, is_active, token_limit, total_tokens, rpm_limit
        FROM gateway_keys WHERE id=?`).get(key.id) as
        { owner_user_id: string | null; service_mode: PlatformMode; is_active: number; token_limit: number; total_tokens: number; rpm_limit: number } | undefined;
      if (!current || current.is_active !== 1) throw new RelayError("Invalid API Key", 401);
      if (current.token_limit > 0 && current.total_tokens >= current.token_limit) {
        throw new RelayError("API Key token limit exceeded", 429);
      }
      const providerMode = this.isProviderMode();
      const relayMode = this.isRelayMode();
      const userPortalMode = providerMode || relayMode;
      if (userPortalMode && !current.owner_user_id) throw new RelayError("This mode requires an account-owned API Key", 403);
      if (!userPortalMode && current.owner_user_id) throw new RelayError("User API Keys are unavailable in the current mode", 403);
      const activeMode: PlatformMode = relayMode ? "relay" : providerMode ? "provider" : "personal";
      if (current.service_mode !== activeMode) throw new RelayError("This API Key was issued for a different service mode; create a new key for the current mode", 403);
      if (current.owner_user_id) {
        const user = this.sqlite.prepare("SELECT balance, is_active FROM platform_users WHERE id=?").get(current.owner_user_id) as
          { balance: number; is_active: number } | undefined;
        if (!user || !user.is_active) throw new RelayError("Account disabled", 403);
        if (providerMode && user.balance <= 0) throw new RelayError("Insufficient balance", 402);
      }
      if (current.rpm_limit > 0) {
        const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM gateway_request_events WHERE key_id=? AND created_at >= ?")
          .get(key.id, new Date(Date.now() - 60_000).toISOString()) as { count: number };
        if (row.count >= current.rpm_limit) throw new RelayError("Rate limit exceeded", 429);
      }
      if (relayMode && current.owner_user_id && options.countRelayRequest !== false) this.reserveRelayRequest(current.owner_user_id, key.id, now);
      this.sqlite.prepare("INSERT INTO gateway_request_events(key_id, created_at) VALUES(?, ?)").run(key.id, now);
      this.sqlite.prepare("DELETE FROM gateway_request_events WHERE created_at < ?").run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    });
    reserve.immediate();
  }

  recordRelayRequest(key: GatewayKey): void {
    const now = isoNow();
    const reserve = this.sqlite.transaction(() => {
      if (!this.isRelayMode()) throw new RelayError("Relay mode is disabled", 403);
      const current = this.sqlite.prepare(`SELECT owner_user_id,service_mode,is_active,token_limit,total_tokens
        FROM gateway_keys WHERE id=?`).get(key.id) as
        { owner_user_id: string | null; service_mode: PlatformMode; is_active: number; token_limit: number; total_tokens: number } | undefined;
      if (!current || current.is_active !== 1) throw new RelayError("Invalid API Key", 401);
      if (current.owner_user_id !== key.owner_user_id || !current.owner_user_id || current.service_mode !== "relay") {
        throw new RelayError("This API Key is not available in relay mode", 403);
      }
      if (current.token_limit > 0 && current.total_tokens >= current.token_limit) {
        throw new RelayError("API Key token limit exceeded", 429);
      }
      const user = this.sqlite.prepare("SELECT is_active FROM platform_users WHERE id=?").get(current.owner_user_id) as
        { is_active: number } | undefined;
      if (!user || user.is_active !== 1) throw new RelayError("Account disabled", 403);
      this.reserveRelayRequest(current.owner_user_id, key.id, now);
    });
    reserve.immediate();
  }

  private reserveRelayRequest(userId: string, keyId: string, now: string): void {
    if (!this.isRelayMode()) throw new RelayError("Relay mode is disabled", 403);
    let requestLimit = 0;
    let periodStart: string;
    if (this.getRelayBillingMode() === "monthly") {
      const period = this.sqlite.prepare(`SELECT starts_at AS startsAt, expires_at AS expiresAt, request_limit AS requestLimit
        FROM relay_subscription_periods WHERE user_id=? AND starts_at<=? AND expires_at>? ORDER BY starts_at DESC LIMIT 1`)
        .get(userId, now, now) as { startsAt: string; expiresAt: string; requestLimit: number } | undefined;
      if (!period) throw new RelayError("转发订阅已到期或尚未开通，请完成月度订阅后重试", 402);
      periodStart = period.startsAt;
      requestLimit = period.requestLimit;
    } else {
      const date = new Date(now);
      periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
      requestLimit = Number(this.setting("relay_free_monthly_requests") || "0");
    }
    if (requestLimit > 0) {
      const used = this.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_request_events WHERE user_id=? AND created_at>=?")
        .get(userId, periodStart) as { count: number };
      if (used.count >= requestLimit) throw new RelayError("本周期转发请求额度已用完", 429);
    }
    this.sqlite.prepare("INSERT INTO relay_request_events(user_id,key_id,created_at) VALUES(?,?,?)").run(userId, keyId, now);
    if (Date.now() - this.lastRelayEventPruneAt > 60 * 60_000) {
      this.lastRelayEventPruneAt = Date.now();
      const cutoff = new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString();
      this.sqlite.prepare("DELETE FROM relay_request_events WHERE created_at<?").run(cutoff);
    }
  }

  recordDirectRequest(keyId: string): void {
    const now = isoNow();
    this.sqlite.prepare("INSERT INTO gateway_request_events(key_id, created_at) VALUES(?, ?)").run(keyId, now);
    this.sqlite.prepare("DELETE FROM gateway_request_events WHERE created_at < ?").run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
  }

  allowedModels(key: GatewayKey): string[] {
    const current = this.sqlite.prepare("SELECT is_active, model_filter FROM gateway_keys WHERE id=?").get(key.id) as
      { is_active: number; model_filter: string } | undefined;
    if (!current || current.is_active !== 1) throw new RelayError("Invalid API Key", 401);
    const parsed = this.parseStoredModelFilter(current.model_filter);
    if (!parsed) throw new RelayError("API Key model permissions are invalid", 403);
    return parsed;
  }

  private normalizeModelFilter(input: unknown, ownerUserId: string | null = null): string[] {
    if (!Array.isArray(input) || input.length > 256) throw new Error("模型权限必须是最多 256 项的模型名称数组");
    const names = [...new Set(input.map(value => {
      if (typeof value !== "string") throw new Error("模型权限包含无效名称");
      const name = value.trim();
      if (!name || name.length > 128 || /[\0\r\n]/.test(name)) throw new Error("模型权限包含无效名称");
      return name;
    }))];
    if (names.length) {
      const placeholders = names.map(() => "?").join(",");
      const configured = ownerUserId && this.isRelayMode()
        ? this.sqlite.prepare(`SELECT public_name FROM relay_models WHERE user_id=? AND public_name IN (${placeholders})`)
          .all(ownerUserId, ...names) as Array<{ public_name: string }>
        : this.sqlite.prepare(`SELECT public_name FROM platform_models WHERE public_name IN (${placeholders})`)
          .all(...names) as Array<{ public_name: string }>;
      if (configured.length !== names.length) throw new Error("模型权限包含尚未配置的模型");
    }
    return names;
  }

  private parseStoredModelFilter(value: unknown): string[] | null {
    if (typeof value !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length > 256 || parsed.some(name => typeof name !== "string" || !name
        || name.trim() !== name || name.length > 128 || /[\0\r\n]/.test(name))) {
        return null;
      }
      return [...new Set(parsed)];
    } catch { return null; }
  }

  reserveProviderUsage(keyId: string, promptTokens: number, requestedMaxTokens: number | undefined, completionCount: number,
    inputPrice: number, outputPrice: number): { id: string; maxTokens: number; reservedCost: number; tokenReservationId?: string } {
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || !Number.isInteger(completionCount)
      || completionCount < 1 || completionCount > 8) {
      throw new RelayError("Could not determine a safe token budget for this request", 400);
    }
    if (requestedMaxTokens !== undefined && (!Number.isInteger(requestedMaxTokens)
      || requestedMaxTokens < 0 || requestedMaxTokens > MAX_PROVIDER_MAX_TOKENS)) {
      throw new RelayError(`max_tokens must be an integer from 0 to ${MAX_PROVIDER_MAX_TOKENS}`, 400);
    }
    if (![inputPrice, outputPrice].every(price => Number.isFinite(price) && price >= 0)) {
      throw new RelayError("Model pricing is invalid", 503);
    }

    const id = uuidv4();
    const tokenReservationId = uuidv4();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + PROVIDER_RESERVATION_MS).toISOString();
    const reserve = this.sqlite.transaction(() => {
      if (!this.isProviderMode()) throw new RelayError("Service-provider mode is disabled", 403);
      const key = this.sqlite.prepare("SELECT owner_user_id, token_limit, total_tokens FROM gateway_keys WHERE id=? AND is_active=1")
        .get(keyId) as { owner_user_id: string | null; token_limit: number; total_tokens: number } | undefined;
      if (!key?.owner_user_id) throw new RelayError("API Key is not associated with a provider account", 403);
      const user = this.sqlite.prepare("SELECT balance, is_active FROM platform_users WHERE id=?")
        .get(key.owner_user_id) as { balance: number; is_active: number } | undefined;
      if (!user || !user.is_active) throw new RelayError("Account disabled", 403);

      this.sqlite.prepare("DELETE FROM provider_usage_reservations WHERE expires_at <= ?").run(createdAt);
      const held = this.sqlite.prepare("SELECT COALESCE(SUM(reserved_cost), 0) AS amount FROM provider_usage_reservations WHERE user_id=? AND expires_at > ?")
        .get(key.owner_user_id, createdAt) as { amount: number };
      const available = Math.max(0, user.balance - held.amount);
      const promptCost = (promptTokens * inputPrice) / 1_000_000;
      if (promptCost > available + 1e-12) throw new RelayError("Insufficient balance for this prompt", 402);

      let remainingKeyTokens: number | undefined;
      if (key.token_limit > 0) {
        this.sqlite.prepare("DELETE FROM gateway_token_reservations WHERE expires_at <= ?").run(createdAt);
        const heldTokens = this.sqlite.prepare(`SELECT COALESCE(SUM(reserved_tokens), 0) AS amount
          FROM gateway_token_reservations WHERE key_id=? AND expires_at > ?`).get(keyId, createdAt) as { amount: number };
        remainingKeyTokens = Math.max(0, key.token_limit - key.total_tokens - heldTokens.amount);
        if (promptTokens > remainingKeyTokens) throw new RelayError("API Key token limit exceeded", 429);
      }

      let maxTokens = requestedMaxTokens;
      if (maxTokens === undefined) {
        const affordable = outputPrice > 0
          ? Math.floor(((available - promptCost) * 1_000_000) / (outputPrice * completionCount))
          : DEFAULT_PROVIDER_MAX_TOKENS;
        maxTokens = Math.min(DEFAULT_PROVIDER_MAX_TOKENS, Math.max(0, affordable));
      }
      if (remainingKeyTokens !== undefined) {
        const quotaMaxTokens = Math.floor((remainingKeyTokens - promptTokens) / completionCount);
        if (quotaMaxTokens <= 0 && requestedMaxTokens !== 0) throw new RelayError("API Key token limit exceeded", 429);
        maxTokens = Math.min(maxTokens, quotaMaxTokens);
      }
      if (maxTokens * completionCount > MAX_PROVIDER_MAX_TOKENS) {
        throw new RelayError(`The total output limit cannot exceed ${MAX_PROVIDER_MAX_TOKENS} tokens`, 400);
      }
      if (outputPrice > 0 && maxTokens === 0 && requestedMaxTokens === undefined) {
        throw new RelayError("Insufficient balance for one output token", 402);
      }

      const rawCost = promptCost + (maxTokens * completionCount * outputPrice) / 1_000_000;
      const reservedCost = Number(rawCost.toFixed(8));
      if (reservedCost > available + 1e-12) throw new RelayError("Insufficient balance for the requested output limit", 402);
      this.sqlite.prepare(`INSERT INTO provider_usage_reservations(id, key_id, user_id, reserved_cost, created_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?)`)
        .run(id, keyId, key.owner_user_id, reservedCost, createdAt, expiresAt);
      if (remainingKeyTokens !== undefined) {
        this.sqlite.prepare(`INSERT INTO gateway_token_reservations(id, key_id, reserved_tokens, created_at, expires_at)
          VALUES(?, ?, ?, ?, ?)`)
          .run(tokenReservationId, keyId, promptTokens + maxTokens * completionCount, createdAt, expiresAt);
      }
      return { id, maxTokens, reservedCost, ...(remainingKeyTokens === undefined ? {} : { tokenReservationId }) };
    });
    const reservation = reserve.immediate();
    this.reservationLastRenewedAt.set(id, now);
    if (reservation.tokenReservationId) this.reservationLastRenewedAt.set(tokenReservationId, now);
    return reservation;
  }

  reserveGatewayTokenUsage(keyId: string, promptTokens: number, requestedMaxTokens: number | undefined,
    completionCount: number): { id: string; maxTokens: number } {
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 || !Number.isInteger(completionCount)
      || completionCount < 1 || completionCount > 8) {
      throw new RelayError("Could not determine a safe token budget for this request", 400);
    }
    if (requestedMaxTokens !== undefined && (!Number.isInteger(requestedMaxTokens)
      || requestedMaxTokens < 0 || requestedMaxTokens > MAX_PROVIDER_MAX_TOKENS)) {
      throw new RelayError(`max_tokens must be an integer from 0 to ${MAX_PROVIDER_MAX_TOKENS}`, 400);
    }

    const id = uuidv4();
    const createdAt = isoNow();
    const now = Date.now();
    const expiresAt = new Date(now + TOKEN_RESERVATION_MS).toISOString();
    const reserve = this.sqlite.transaction(() => {
      const key = this.sqlite.prepare("SELECT token_limit, total_tokens FROM gateway_keys WHERE id=? AND is_active=1")
        .get(keyId) as { token_limit: number; total_tokens: number } | undefined;
      if (!key) throw new RelayError("API Key is no longer active", 401);
      if (key.token_limit <= 0) return { id: "", maxTokens: requestedMaxTokens ?? MAX_PROVIDER_MAX_TOKENS };

      this.sqlite.prepare("DELETE FROM gateway_token_reservations WHERE expires_at <= ?").run(createdAt);
      const held = this.sqlite.prepare(`SELECT COALESCE(SUM(reserved_tokens), 0) AS amount
        FROM gateway_token_reservations WHERE key_id=? AND expires_at > ?`).get(keyId, createdAt) as { amount: number };
      const available = Math.max(0, key.token_limit - key.total_tokens - held.amount);
      if (promptTokens > available) throw new RelayError("API Key token limit exceeded", 429);
      const outputCapacity = Math.floor((available - promptTokens) / completionCount);
      if (outputCapacity <= 0 && requestedMaxTokens !== 0) throw new RelayError("API Key token limit exceeded", 429);
      const maxTokens = Math.min(requestedMaxTokens ?? MAX_PROVIDER_MAX_TOKENS, outputCapacity);
      this.sqlite.prepare(`INSERT INTO gateway_token_reservations(id, key_id, reserved_tokens, created_at, expires_at)
        VALUES(?, ?, ?, ?, ?)`)
        .run(id, keyId, promptTokens + maxTokens * completionCount, createdAt, expiresAt);
      return { id, maxTokens };
    });
    const reservation = reserve.immediate();
    if (reservation.id) this.reservationLastRenewedAt.set(reservation.id, now);
    return reservation;
  }

  refreshUsageReservations(providerReservationId?: string, tokenReservationId?: string): void {
    const now = Date.now();
    const refreshProvider = !!providerReservationId
      && now - (this.reservationLastRenewedAt.get(providerReservationId) ?? now) >= RESERVATION_RENEW_INTERVAL_MS;
    const refreshToken = !!tokenReservationId
      && now - (this.reservationLastRenewedAt.get(tokenReservationId) ?? now) >= RESERVATION_RENEW_INTERVAL_MS;
    if (!refreshProvider && !refreshToken) return;

    const lifetime = refreshProvider ? PROVIDER_RESERVATION_MS : TOKEN_RESERVATION_MS;
    const expiresAt = new Date(now + lifetime).toISOString();
    const refresh = this.sqlite.transaction(() => {
      if (refreshProvider) {
        this.sqlite.prepare("UPDATE provider_usage_reservations SET expires_at=? WHERE id=?")
          .run(expiresAt, providerReservationId);
      }
      if (refreshToken) {
        this.sqlite.prepare("UPDATE gateway_token_reservations SET expires_at=? WHERE id=?")
          .run(expiresAt, tokenReservationId);
      }
    });
    refresh.immediate();
    if (refreshProvider) this.reservationLastRenewedAt.set(providerReservationId!, now);
    if (refreshToken) this.reservationLastRenewedAt.set(tokenReservationId!, now);
  }

  startUsageReservationHeartbeat(providerReservationId?: string, tokenReservationId?: string,
    onError?: (error: unknown) => void): () => void {
    if (!providerReservationId && !tokenReservationId) return () => undefined;
    const heartbeat = setInterval(() => {
      try {
        this.refreshUsageReservations(providerReservationId, tokenReservationId);
      } catch (error) {
        onError?.(error);
      }
    }, RESERVATION_RENEW_INTERVAL_MS);
    heartbeat.unref?.();
    return () => clearInterval(heartbeat);
  }

  releaseProviderUsage(id: string): void {
    this.sqlite.prepare("DELETE FROM provider_usage_reservations WHERE id=?").run(id);
    this.reservationLastRenewedAt.delete(id);
  }

  releaseGatewayTokenUsage(id: string): void {
    if (id) {
      this.sqlite.prepare("DELETE FROM gateway_token_reservations WHERE id=?").run(id);
      this.reservationLastRenewedAt.delete(id);
    }
  }

  createUserKey(userId: string, name: unknown, tokenLimit: unknown = 0, rpmLimit: unknown = 0, modelFilterInput: unknown = []) {
    if (!this.isUserPortalEnabled()) throw new Error("当前模式未开放用户 API Key");
    const create = this.sqlite.transaction(() => {
      const user = this.sqlite.prepare("SELECT is_active FROM platform_users WHERE id=?").get(userId) as { is_active: number } | undefined;
      if (!user || user.is_active !== 1) throw new Error("账号不存在或已停用");
      const active = this.sqlite.prepare("SELECT COUNT(*) AS count FROM gateway_keys WHERE owner_user_id=? AND is_active=1")
        .get(userId) as { count: number };
      if (active.count >= 20) throw new Error("最多可同时持有 20 个有效密钥");
      return this.createGatewayKey(name, userId, tokenLimit, rpmLimit, modelFilterInput);
    });
    return create.immediate();
  }

  listKeys(ownerUserId?: string) {
    const rows = ownerUserId
      ? this.sqlite.prepare("SELECT * FROM gateway_keys WHERE owner_user_id=? ORDER BY created_at DESC").all(ownerUserId)
      : this.sqlite.prepare(`SELECT k.*, u.email AS owner_email FROM gateway_keys k
        LEFT JOIN platform_users u ON u.id=k.owner_user_id ORDER BY k.created_at DESC`).all();
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const requestRates = new Map((this.sqlite.prepare(`SELECT key_id, COUNT(*) AS count FROM gateway_request_events
      WHERE created_at >= ? GROUP BY key_id`).all(minuteAgo) as Array<{ key_id: string; count: number }>).map(row => [row.key_id, row.count]));
    const tokenRates = new Map((this.sqlite.prepare(`SELECT api_key_id, COALESCE(SUM(total_tokens),0) AS count FROM usage_logs
      WHERE timestamp >= ? GROUP BY api_key_id`).all(minuteAgo) as Array<{ api_key_id: string; count: number }>).map(row => [row.api_key_id, row.count]));
    return (rows as Array<Record<string, any>>).map(row => {
      const modelFilter = this.parseStoredModelFilter(row.model_filter);
      return { id: row.id, name: row.name, prefix: row.prefix,
        ownerUserId: row.owner_user_id, active: row.is_active === 1, tokenLimit: row.token_limit, rpmLimit: row.rpm_limit,
        serviceMode: row.service_mode, usableInCurrentMode: row.service_mode === (this.isRelayMode() ? "relay" : this.isProviderMode() ? "provider" : "personal"),
        modelFilter: modelFilter ?? [], modelFilterValid: modelFilter !== null,
        ...(ownerUserId === undefined ? { ownerEmail: row.owner_email ?? null } : {}),
        totalTokens: row.total_tokens, totalRequests: row.total_requests, createdAt: row.created_at, lastUsedAt: row.last_used_at,
        requestsLastMinute: requestRates.get(row.id) ?? 0, tokensLastMinute: tokenRates.get(row.id) ?? 0 };
    });
  }

  disableKey(id: string, ownerUserId?: string): boolean {
    const result = ownerUserId
      ? this.sqlite.prepare("UPDATE gateway_keys SET is_active=0 WHERE id=? AND owner_user_id=?").run(id, ownerUserId)
      : this.sqlite.prepare("UPDATE gateway_keys SET is_active=0 WHERE id=?").run(id);
    return result.changes > 0;
  }

  updateKeyLimits(id: string, tokenLimitInput: unknown, rpmLimitInput: unknown, ownerUserId?: string, modelFilterInput?: unknown) {
    const tokenLimit = Math.floor(safeNumber(tokenLimitInput, "Token 限额", 0, 1_000_000_000_000));
    const rpmLimit = Math.floor(safeNumber(rpmLimitInput, "每分钟请求上限", 0, 100_000));
    const update = this.sqlite.transaction(() => {
      const existing = ownerUserId === undefined
        ? this.sqlite.prepare("SELECT id,owner_user_id FROM gateway_keys WHERE id=?").get(id) as { id: string; owner_user_id: string | null } | undefined
        : this.sqlite.prepare("SELECT id,owner_user_id FROM gateway_keys WHERE id=? AND owner_user_id=?").get(id, ownerUserId) as { id: string; owner_user_id: string | null } | undefined;
      if (!existing) return false;
      if (modelFilterInput === undefined) {
        return this.sqlite.prepare("UPDATE gateway_keys SET token_limit=?, rpm_limit=? WHERE id=?")
          .run(tokenLimit, rpmLimit, id).changes > 0;
      }
      const filterOwner = ownerUserId === undefined ? existing.owner_user_id : ownerUserId;
      const modelFilter = JSON.stringify(this.normalizeModelFilter(modelFilterInput, filterOwner));
      return this.sqlite.prepare("UPDATE gateway_keys SET token_limit=?, rpm_limit=?, model_filter=? WHERE id=?")
        .run(tokenLimit, rpmLimit, modelFilter, id).changes > 0;
    });
    const changed = update.immediate();
    return changed ? this.listKeys(ownerUserId).find(key => key.id === id) ?? null : null;
  }

  private addBalanceEntry(userId: string, type: "topup" | "usage" | "adjustment", amount: number,
    balanceAfter: number, referenceId: string | null, description: string, actor = "system", createdAt = isoNow()): void {
    this.sqlite.prepare(`INSERT INTO platform_balance_entries(id, user_id, entry_type, amount, balance_after,
      reference_id, description, actor, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), userId, type, Number(amount.toFixed(8)), Number(balanceAfter.toFixed(8)), referenceId,
        description.slice(0, 300), actor.slice(0, 80), createdAt);
  }

  recordUsage(keyId: string, publicModel: string, endpoint: string, prompt: number, completion: number, ip: string,
    userAgent: string, inputPrice = 0, outputPrice = 0, reservationId?: string, tokenReservationId?: string): void {
    const input = Math.max(0, Math.floor(prompt));
    const output = Math.max(0, Math.floor(completion));
    const total = input + output;
    const cost = Number(((input * inputPrice + output * outputPrice) / 1_000_000).toFixed(8));
    const now = isoNow();
    const transaction = this.sqlite.transaction(() => {
      const usageLog = this.sqlite.prepare(`INSERT INTO usage_logs(api_key_id, model, endpoint, prompt_tokens, completion_tokens, total_tokens,
        timestamp, ip, user_agent, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        keyId, publicModel, endpoint, input, output, total, now, ip || null, userAgent.slice(0, 512), cost);
      this.sqlite.prepare(`UPDATE gateway_keys SET last_used_at=?, total_tokens=total_tokens+?, total_requests=total_requests+1
        WHERE id=?`).run(now, total, keyId);
      const key = this.sqlite.prepare("SELECT owner_user_id FROM gateway_keys WHERE id=?").get(keyId) as { owner_user_id: string | null } | undefined;
      const reservation = reservationId
        ? this.sqlite.prepare("SELECT user_id FROM provider_usage_reservations WHERE id=? AND key_id=?").get(reservationId, keyId) as { user_id: string } | undefined
        : undefined;
      if (key?.owner_user_id && (this.isProviderMode() || reservation?.user_id === key.owner_user_id) && cost > 0) {
        const debited = this.sqlite.prepare("UPDATE platform_users SET balance=round(balance-?, 8) WHERE id=?").run(cost, key.owner_user_id);
        if (debited.changes) {
          const user = this.sqlite.prepare("SELECT balance FROM platform_users WHERE id=?").get(key.owner_user_id) as { balance: number };
          this.addBalanceEntry(key.owner_user_id, "usage", -cost, user.balance, String(usageLog.lastInsertRowid),
            `${publicModel}: ${input} 输入 Token，${output} 输出 Token`, "system", now);
        }
      }
      if (reservationId) this.sqlite.prepare("DELETE FROM provider_usage_reservations WHERE id=? AND key_id=?").run(reservationId, keyId);
      if (tokenReservationId) this.sqlite.prepare("DELETE FROM gateway_token_reservations WHERE id=? AND key_id=?").run(tokenReservationId, keyId);
    });
    transaction.immediate();
    if (reservationId) this.reservationLastRenewedAt.delete(reservationId);
    if (tokenReservationId) this.reservationLastRenewedAt.delete(tokenReservationId);
  }

  overview() {
    const aggregate = this.sqlite.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS input,
      COALESCE(SUM(completion_tokens),0) AS output, COALESCE(SUM(cost),0) AS revenue
      FROM usage_logs WHERE timestamp >= ?`).get(new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as any;
    const online = this.tunnel.getOnlineNodes().filter(node => node.serverRunning);
    const hours = this.sqlite.prepare(`SELECT substr(timestamp, 1, 13) AS hour, COUNT(*) AS requests,
      SUM(prompt_tokens) AS input, SUM(completion_tokens) AS output FROM usage_logs
      WHERE timestamp >= ? GROUP BY hour ORDER BY hour`).all(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const models = this.sqlite.prepare(`SELECT model, COUNT(*) AS requests, SUM(total_tokens) AS tokens,
      SUM(cost) AS cost FROM usage_logs WHERE timestamp >= ? GROUP BY model ORDER BY requests DESC LIMIT 10`)
      .all(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const rate = this.sqlite.prepare("SELECT COUNT(*) AS count FROM gateway_request_events WHERE created_at >= ?")
      .get(new Date(Date.now() - 60_000).toISOString()) as { count: number };
    const tokensPerMinute = this.sqlite.prepare("SELECT COALESCE(SUM(total_tokens),0) AS count FROM usage_logs WHERE timestamp >= ?")
      .get(new Date(Date.now() - 60_000).toISOString()) as { count: number };
    return { ...aggregate, requestsPerMinute: rate.count, tokensPerMinute: tokensPerMinute.count,
      onlineNodes: online.length, totalNodes: this.tunnel.getOnlineNodes().length,
      models, hourly: hours, tunnel: this.tunnel.statusSnapshot() };
  }

  publicOverview() {
    const overview = this.overview();
    return {
      requests: overview.requests,
      input: overview.input,
      output: overview.output,
      requestsPerMinute: overview.requestsPerMinute,
      tokensPerMinute: overview.tokensPerMinute,
      onlineNodes: overview.onlineNodes,
      totalNodes: overview.totalNodes,
      models: overview.models.map((model: any) => ({ model: model.model, requests: model.requests, tokens: model.tokens })),
      hourly: overview.hourly,
      tunnel: overview.tunnel,
    };
  }

  publicStatusSnapshot() {
    if (this.isRelayMode()) {
      return { serviceName: this.setting("service_name") || "OpenMyModel", mode: "relay", status: "online" };
    }
    return this.tunnel.statusSnapshot();
  }

  usageRows(ownerUserId?: string, limit = 100) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100;
    const relayMode = this.isRelayMode();
    const rows = ownerUserId
      ? this.sqlite.prepare(`SELECT l.*, CASE WHEN ? THEN 0 ELSE l.cost END AS cost, k.name AS key_name
        FROM usage_logs l JOIN gateway_keys k ON k.id=l.api_key_id
        WHERE k.owner_user_id=? ORDER BY l.timestamp DESC LIMIT ?`).all(relayMode ? 1 : 0, ownerUserId, bounded)
      : this.sqlite.prepare(`SELECT l.*, k.name AS key_name FROM usage_logs l LEFT JOIN gateway_keys k ON k.id=l.api_key_id
        ORDER BY l.timestamp DESC LIMIT ?`).all(bounded);
    return rows;
  }

  adminUsageRows(ownerUserId?: string, limit = 200) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 200;
    return this.sqlite.prepare(`SELECT l.*, CASE WHEN l.api_key_id LIKE 'direct-%' THEN '节点 Key 直连' ELSE k.name END AS key_name,
      u.email AS user_email
      FROM usage_logs l LEFT JOIN gateway_keys k ON k.id=l.api_key_id
      LEFT JOIN platform_users u ON u.id=k.owner_user_id
      WHERE (? IS NULL OR k.owner_user_id=?) ORDER BY l.timestamp DESC LIMIT ?`)
      .all(ownerUserId ?? null, ownerUserId ?? null, bounded);
  }

  userDashboard(userId: string) {
    const user = this.sqlite.prepare("SELECT id, email, balance, created_at FROM platform_users WHERE id=?").get(userId) as any;
    if (!user) throw new Error("账号不存在");
    const stats = this.sqlite.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS input,
      COALESCE(SUM(completion_tokens),0) AS output, COALESCE(SUM(cost),0) AS cost FROM usage_logs l
      JOIN gateway_keys k ON k.id=l.api_key_id WHERE k.owner_user_id=? AND l.timestamp>=?`)
      .get(userId, new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
    const frequency = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM gateway_request_events e JOIN gateway_keys k ON k.id=e.key_id
      WHERE k.owner_user_id=? AND e.created_at>=?`).get(userId, new Date(Date.now() - 60_000).toISOString()) as { count: number };
    const tokenRate = this.sqlite.prepare(`SELECT COALESCE(SUM(l.total_tokens),0) AS count FROM usage_logs l
      JOIN gateway_keys k ON k.id=l.api_key_id WHERE k.owner_user_id=? AND l.timestamp>=?`)
      .get(userId, new Date(Date.now() - 60_000).toISOString()) as { count: number };
    if (this.isRelayMode()) (stats as any).cost = 0;
    return { user: { email: user.email, balance: this.isProviderMode() ? user.balance : 0, createdAt: user.created_at }, stats,
      requestsPerMinute: frequency.count, tokensPerMinute: tokenRate.count,
      keys: this.listKeys(userId), usage: this.usageRows(userId, 30),
      models: this.isRelayMode() ? this.publicRelayModels(userId) : this.listPublicModels(),
      mode: this.isRelayMode() ? "relay" : "provider",
      ...(this.isRelayMode() ? { relay: this.relaySubscriptionSummary(userId) } : {}) };
  }

  relaySubscriptionSummary(userId: string) {
    const now = isoNow();
    const periods = this.sqlite.prepare(`SELECT id,starts_at AS startsAt,expires_at AS expiresAt,amount,request_limit AS requestLimit
      FROM relay_subscription_periods WHERE user_id=? ORDER BY starts_at DESC LIMIT 2`).all(userId) as
      Array<{ id: string; startsAt: string; expiresAt: string; amount: number; requestLimit: number }>;
    const active = periods.find(period => period.startsAt <= now && period.expiresAt > now) ?? null;
    const next = periods.find(period => period.startsAt > now) ?? null;
    const billingMode = this.getRelayBillingMode();
    const freeLimit = Number(this.setting("relay_free_monthly_requests") || "0");
    const date = new Date(now);
    const freeStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
    const usageStart = billingMode === "monthly" ? active?.startsAt : freeStart;
    const requestLimit = billingMode === "monthly" ? active?.requestLimit ?? 0 : freeLimit;
    const used = usageStart
      ? (this.sqlite.prepare("SELECT COUNT(*) AS count FROM relay_request_events WHERE user_id=? AND created_at>=?")
        .get(userId, usageStart) as { count: number }).count : 0;
    return {
      billingMode,
      status: billingMode === "free" ? "free" : active ? "active" : next ? "scheduled" : "expired",
      current: active ? { startsAt: active.startsAt, expiresAt: active.expiresAt, price: active.amount,
        requestLimit: active.requestLimit } : null,
      next: next ? { startsAt: next.startsAt, expiresAt: next.expiresAt, price: next.amount,
        requestLimit: next.requestLimit } : null,
      currentPrice: Number(this.setting("relay_monthly_price") || "0"),
      requestLimit, requestsUsed: used,
      requestsRemaining: requestLimit > 0 ? Math.max(0, requestLimit - used) : null,
      freeMonthlyRequests: freeLimit,
    };
  }

  listPublicModels() {
    const live = new Set(this.tunnel.getOnlineNodes().filter(node => node.serverRunning).map(node => node.id));
    const models = this.adminModels();
    return models.filter(model => model.enabled && model.routes.some(route => route.enabled && route.keyConfigured && live.has(route.nodeId)))
      .map(model => ({ id: model.publicName, remark: model.remark, inputPrice: model.inputPrice, outputPrice: model.outputPrice }));
  }

  keyModelOptions(userId?: string) {
    if (userId && this.isRelayMode()) {
      return this.sqlite.prepare("SELECT public_name AS id FROM relay_models WHERE user_id=? AND enabled=1 ORDER BY public_name COLLATE NOCASE")
        .all(userId) as Array<{ id: string }>;
    }
    return this.sqlite.prepare("SELECT public_name AS id FROM platform_models WHERE enabled=1 ORDER BY public_name COLLATE NOCASE")
      .all() as Array<{ id: string }>;
  }

  adminUsers() {
    const onlineByOwner = new Map<string, number>();
    for (const node of this.tunnel.getOnlineNodes()) if (node.ownerUserId) {
      onlineByOwner.set(node.ownerUserId, (onlineByOwner.get(node.ownerUserId) ?? 0) + 1);
    }
    const now = isoNow();
    const users = this.sqlite.prepare(`SELECT u.id, u.email, u.balance, u.is_active AS active, u.created_at AS createdAt,
      u.last_login_at AS lastLoginAt, (SELECT COUNT(*) FROM gateway_keys k WHERE k.owner_user_id=u.id) AS keyCount,
      (SELECT COALESCE(SUM(l.total_tokens),0) FROM usage_logs l JOIN gateway_keys k ON k.id=l.api_key_id WHERE k.owner_user_id=u.id) AS tokens,
      (SELECT COUNT(*) FROM relay_node_credentials c WHERE c.user_id=u.id AND c.revoked_at IS NULL) AS relayNodeCount,
      (SELECT COUNT(*) FROM relay_subscription_periods p WHERE p.user_id=u.id AND p.starts_at<=? AND p.expires_at>?) AS activeSubscriptions,
      (SELECT MAX(p.expires_at) FROM relay_subscription_periods p WHERE p.user_id=u.id AND p.expires_at>?) AS relayExpiresAt
      FROM platform_users u ORDER BY u.created_at DESC`).all(now, now, now) as Array<Record<string, any>>;
    return users.map(user => ({ ...user, onlineRelayNodes: onlineByOwner.get(user.id) ?? 0 }));
  }

  updateUser(id: string, input: Record<string, unknown>) {
    if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("账号状态必须是布尔值");
    const disconnectNodes: string[] = [];
    const transaction = this.sqlite.transaction(() => {
      const current = this.sqlite.prepare("SELECT balance FROM platform_users WHERE id=?").get(id) as { balance: number } | undefined;
      if (!current) return null;
      if (input.balance !== undefined) {
        const balance = Number(safeNumber(input.balance, "余额", -1_000_000_000, 1_000_000_000).toFixed(8));
        const now = isoNow();
        this.sqlite.prepare("DELETE FROM provider_usage_reservations WHERE expires_at <= ?").run(now);
        const held = this.sqlite.prepare(`SELECT COALESCE(SUM(reserved_cost), 0) AS amount
          FROM provider_usage_reservations WHERE user_id=? AND expires_at > ?`).get(id, now) as { amount: number };
        if (balance + 1e-12 < held.amount) {
          throw new Error(`余额不能低于推理请求已预留金额 ¥${held.amount.toFixed(8)}，请待请求结算后再调整`);
        }
        const delta = Number((balance - current.balance).toFixed(8));
        if (delta !== 0) {
          const reason = typeof input.reason === "string" ? input.reason.trim() : "";
          if (!reason || reason.length > 300) throw new Error("余额调整必须填写 1–300 个字符的原因");
          this.sqlite.prepare("UPDATE platform_users SET balance=? WHERE id=?").run(balance, id);
          this.addBalanceEntry(id, "adjustment", delta, balance, null, reason, "admin");
        }
      }
      if (input.active !== undefined) {
        this.sqlite.prepare("UPDATE platform_users SET is_active=? WHERE id=?").run(input.active ? 1 : 0, id);
        if (!input.active) {
          this.sqlite.prepare("DELETE FROM platform_sessions WHERE user_id=?").run(id);
          const nodeRows = this.sqlite.prepare(`SELECT node_id AS nodeId FROM relay_node_credentials
            WHERE user_id=? AND revoked_at IS NULL`).all(id) as Array<{ nodeId: string }>;
          disconnectNodes.push(...nodeRows.map(node => node.nodeId));
          this.sqlite.prepare("UPDATE nodes SET is_online=0 WHERE owner_user_id=?").run(id);
        }
      }
      return this.adminUsers().find((user: any) => user.id === id) ?? null;
    });
    const result = transaction.immediate();
    for (const nodeId of disconnectNodes) this.tunnel.disconnectNode(nodeId);
    if (input.active === false) {
      for (const node of this.tunnel.getOnlineNodes()) if (node.ownerUserId === id) this.tunnel.disconnectNode(node.id);
    }
    return result;
  }

  balanceEntries(userId: string, limit = 100) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100;
    return this.sqlite.prepare(`SELECT id, entry_type AS type, amount, balance_after AS balanceAfter,
      reference_id AS referenceId, description, actor, created_at AS createdAt
      FROM platform_balance_entries WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(userId, bounded);
  }

  orders(ownerUserId?: string) {
    return ownerUserId
      ? this.sqlite.prepare(`SELECT id, amount, status, purpose, relay_request_limit AS relayRequestLimit, description, created_at AS createdAt, paid_at AS paidAt
        FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100`).all(ownerUserId)
      : this.sqlite.prepare(`SELECT o.id, u.email, o.amount, o.status, o.purpose, o.description, o.created_at AS createdAt,
        o.relay_request_limit AS relayRequestLimit, o.paid_at AS paidAt, o.trade_no AS tradeNo FROM payment_orders o JOIN platform_users u ON u.id=o.user_id
        ORDER BY o.created_at DESC LIMIT 500`).all();
  }

  createOrder(userId: string, amountInput: unknown, returnUrl: string): { orderId: string; amount: number; paymentUrl: string } {
    if (!this.isProviderMode()) throw new Error("服务商模式尚未启用");
    const amountText = typeof amountInput === "number" && Number.isFinite(amountInput)
      ? String(amountInput) : typeof amountInput === "string" ? amountInput.trim() : "";
    const match = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(amountText);
    if (!match) throw new Error("充值金额必须为 1 至 100000 元，且最多保留两位小数");
    const amountCents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 10_000_000) {
      throw new Error("充值金额必须为 1 至 100000 元，且最多保留两位小数");
    }
    const amount = amountCents / 100;
    const id = `OM${Date.now()}${randomBytes(6).toString("hex").toUpperCase()}`;
    const paymentUrl = this.alipayPaymentUrl(id, amount, returnUrl);
    this.sqlite.prepare(`INSERT INTO payment_orders(id,user_id,amount,description,created_at,purpose) VALUES(?,?,?,?,?,'topup')`)
      .run(id, userId, amount, `${this.setting("service_name") || "OpenMyModel"} 账户充值`, isoNow());
    return { orderId: id, amount, paymentUrl };
  }

  createRelaySubscriptionOrder(userId: string, returnUrl: string): { orderId: string; amount: number; paymentUrl: string; requestLimit: number } {
    if (!this.isRelayMode() || this.getRelayBillingMode() !== "monthly") throw new Error("当前服务未开放月度订阅");
    const user = this.sqlite.prepare("SELECT is_active FROM platform_users WHERE id=?").get(userId) as { is_active: number } | undefined;
    if (!user?.is_active) throw new Error("账号不存在或已停用");
    const amount = Number(this.setting("relay_monthly_price"));
    const amountCents = Math.round(amount * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100_000_000) throw new Error("月度订阅价格尚未正确设置");
    const requestLimit = Math.floor(Number(this.setting("relay_monthly_requests") || "0"));
    const order = this.sqlite.transaction(() => {
      const pending = this.sqlite.prepare(`SELECT id,amount,relay_request_limit AS requestLimit FROM payment_orders
        WHERE user_id=? AND purpose='relay_subscription' AND status='pending' ORDER BY created_at DESC`)
        .all(userId) as Array<{ id: string; amount: number; requestLimit: number }>;
      const matching = pending.find(candidate => Math.round(candidate.amount * 100) === amountCents
        && candidate.requestLimit === requestLimit);
      for (const candidate of pending) {
        if (candidate.id !== matching?.id) {
          this.sqlite.prepare("UPDATE payment_orders SET status='closed' WHERE id=? AND status='pending'").run(candidate.id);
        }
      }
      if (matching) return { orderId: matching.id, amount: matching.amount, requestLimit: matching.requestLimit };
      const orderId = `OMR${Date.now()}${randomBytes(6).toString("hex").toUpperCase()}`;
      const orderAmount = amountCents / 100;
      this.sqlite.prepare(`INSERT INTO payment_orders(id,user_id,amount,description,created_at,purpose,relay_request_limit)
        VALUES(?,?,?,?,?,'relay_subscription',?)`).run(orderId, userId, orderAmount,
        `${this.setting("service_name") || "OpenMyModel"} 月度代转发订阅`, isoNow(), requestLimit);
      return { orderId, amount: orderAmount, requestLimit };
    }).immediate();
    const subject = `${this.setting("service_name") || "OpenMyModel"} 月度代转发订阅`;
    return { ...order, paymentUrl: this.alipayPaymentUrl(order.orderId, order.amount, returnUrl, subject) };
  }

  private addOneCalendarMonth(start: string): string {
    const date = new Date(start);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date.toISOString();
  }

  private alipayPaymentUrl(orderId: string, amount: number, returnUrl: string, subject = `${this.setting("service_name") || "OpenMyModel"} 账户充值`): string {
    const origin = this.setting("public_url").trim().replace(/\/$/, "");
    const appBase = origin || new URL(returnUrl).origin;
    const gateway = this.setting("alipay_gateway") || "https://openapi.alipay.com/gateway.do";
    const fields: Record<string, string> = {
      app_id: this.setting("alipay_app_id"), method: "alipay.trade.page.pay", format: "JSON", charset: "utf-8",
      sign_type: "RSA2", timestamp: new Date().toISOString().slice(0, 19).replace("T", " "), version: "1.0",
      notify_url: `${appBase}/api/payments/alipay/notify`, return_url: returnUrl,
      biz_content: JSON.stringify({ out_trade_no: orderId, product_code: "FAST_INSTANT_TRADE_PAY",
        total_amount: amount.toFixed(2), subject }),
    };
    const canonical = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
    const sign = createSign("RSA-SHA256").update(canonical, "utf8").sign(this.secretSetting("alipay_private_key"), "base64");
    const query = new URLSearchParams(fields);
    query.set("sign", sign);
    return `${gateway}${gateway.includes("?") ? "&" : "?"}${query.toString()}`;
  }

  processAlipayNotification(fields: Record<string, unknown>): boolean {
    const entries = Object.entries(fields);
    if (entries.length > 100 || entries.some(([key, value]) => key.length > 128 || String(value).length > 8192)) return false;
    const signature = fields.sign;
    if (typeof signature !== "string" || fields.sign_type !== "RSA2"
      || fields.app_id !== this.setting("alipay_app_id")
      || fields.auth_app_id !== undefined && fields.auth_app_id !== this.setting("alipay_app_id")
      || fields.seller_id !== this.setting("alipay_seller_id") || fields.notify_type !== "trade_status_sync") return false;
    const canonicalFields = { ...fields };
    delete canonicalFields.sign;
    delete canonicalFields.sign_type;
    const canonical = Object.keys(canonicalFields).filter(key => canonicalFields[key] !== "" && canonicalFields[key] != null).sort()
      .map(key => `${key}=${typeof canonicalFields[key] === "string" ? canonicalFields[key] : JSON.stringify(canonicalFields[key])}`).join("&");
    const publicKey = this.secretSetting("alipay_public_key");
    let verified = false;
    try { verified = createVerify("RSA-SHA256").update(canonical, "utf8").verify(publicKey, signature, "base64"); }
    catch { /* Malformed signatures are rejected below. */ }
    if (!verified) return false;
    const orderId = typeof fields.out_trade_no === "string" ? fields.out_trade_no : "";
    if (!orderId || orderId.length > 128) return false;
    if (fields.trade_status === "TRADE_CLOSED") {
      this.sqlite.prepare("UPDATE payment_orders SET status='closed' WHERE id=? AND status='pending'").run(orderId);
      return true;
    }
    if (fields.trade_status !== "TRADE_SUCCESS" && fields.trade_status !== "TRADE_FINISHED") return true;
    const tradeNo = typeof fields.trade_no === "string" ? fields.trade_no : "";
    const paidAmount = fields.total_amount;
    const paidCents = typeof paidAmount === "string" && /^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(paidAmount)
      ? Number(paidAmount.replace(".", "")) : Number.NaN;
    if (!tradeNo || tradeNo.length > 128 || !Number.isSafeInteger(paidCents)) return false;
    const transaction = this.sqlite.transaction(() => {
      const order = this.sqlite.prepare(`SELECT id,user_id,amount,status,trade_no,purpose,relay_request_limit
        FROM payment_orders WHERE id=?`).get(orderId) as
        { id: string; user_id: string; amount: number; status: string; trade_no: string | null; purpose: string; relay_request_limit: number } | undefined;
      if (!order || paidCents !== Math.round(Number(order.amount) * 100)) return false;
      if (order.status === "paid") return order.trade_no === tradeNo;
      if (order.status !== "pending") return false;

      const existingTrade = this.sqlite.prepare("SELECT id FROM payment_orders WHERE trade_no=? AND id<>? LIMIT 1")
        .get(tradeNo, order.id) as { id: string } | undefined;
      if (existingTrade) return false;

      const user = this.sqlite.prepare("SELECT balance FROM platform_users WHERE id=?").get(order.user_id) as { balance: number } | undefined;
      if (!user) return false;
      if (order.purpose !== "topup" && order.purpose !== "relay_subscription") return false;
      const updated = this.sqlite.prepare("UPDATE payment_orders SET status='paid', paid_at=?, trade_no=? WHERE id=? AND status='pending'")
        .run(isoNow(), tradeNo, order.id);
      if (updated.changes) {
        if (order.purpose === "relay_subscription") {
          const now = isoNow();
          const latest = this.sqlite.prepare("SELECT MAX(expires_at) AS expiresAt FROM relay_subscription_periods WHERE user_id=?")
            .get(order.user_id) as { expiresAt: string | null };
          const startsAt = latest.expiresAt && latest.expiresAt > now ? latest.expiresAt : now;
          const expiresAt = this.addOneCalendarMonth(startsAt);
          this.sqlite.prepare(`INSERT INTO relay_subscription_periods(id,user_id,order_id,starts_at,expires_at,amount,request_limit,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(uuidv4(), order.user_id, order.id, startsAt, expiresAt, order.amount,
            order.relay_request_limit, now);
        } else if (order.purpose === "topup") {
          this.sqlite.prepare("UPDATE platform_users SET balance=round(balance+?, 8) WHERE id=?").run(order.amount, order.user_id);
          const balance = this.sqlite.prepare("SELECT balance FROM platform_users WHERE id=?").get(order.user_id) as { balance: number };
          this.addBalanceEntry(order.user_id, "topup", order.amount, balance.balance, order.id,
            `${this.setting("service_name") || "OpenMyModel"} 支付宝充值`, "alipay");
        } else {
          return false;
        }
      }
      return true;
    });
    return transaction.immediate();
  }

  adminNodeList() {
    const nodes = new Map<string, Record<string, any>>();
    const stored = this.sqlite.prepare(`SELECT n.id, n.name, n.connected_at AS connectedAt, n.last_heartbeat AS lastHeartbeat,
      n.model_name AS modelName, n.model_config AS modelConfig, n.upstream_api_key AS upstreamApiKey,
      n.owner_user_id AS ownerUserId, u.email AS ownerEmail FROM nodes n
      LEFT JOIN platform_users u ON u.id=n.owner_user_id`).all() as Array<Record<string, any>>;
    for (const node of stored) {
      const { upstreamApiKey, ...safeNode } = node;
      nodes.set(node.id, { ...safeNode, keyConfigured: !!upstreamApiKey, isOnline: false, serverRunning: false, slots: null });
    }
    for (const node of this.tunnel.getOnlineNodes()) {
      nodes.set(node.id, { ...nodes.get(node.id), ...node, isOnline: true });
    }
    const routes = this.sqlite.prepare("SELECT node_id, COUNT(*) AS route_count FROM model_routes GROUP BY node_id").all() as Array<any>;
    const byId = new Map(routes.map(row => [row.node_id, row.route_count]));
    const rows = [...nodes.values()]
      .map((node): Record<string, any> => ({ ...node, routeCount: byId.get(node.id) || 0 }))
      .filter((node: Record<string, any>) => !this.isRelayMode() || !!node.ownerUserId);
    return rows.sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || String(a.name).localeCompare(String(b.name)));
  }

  removeOfflineNode(nodeIdInput: unknown): boolean {
    const nodeId = typeof nodeIdInput === "string" ? nodeIdInput.trim() : "";
    if (!nodeId || nodeId.length > 256) return false;
    const remove = this.sqlite.transaction(() => {
      const node = this.sqlite.prepare("SELECT id FROM nodes WHERE id=?").get(nodeId);
      if (!node) return false;
      const owner = this.sqlite.prepare("SELECT owner_user_id FROM nodes WHERE id=?").get(nodeId) as { owner_user_id: string | null };
      if (owner.owner_user_id) throw new NodeRemovalBlockedError("个人代转发节点只能由所属用户撤销");
      if (this.tunnel.getOnlineNodes().some(online => online.id === nodeId)) {
        throw new NodeRemovalBlockedError("节点仍连接到服务器，请先在桌面端断开连接");
      }
      const routes = this.sqlite.prepare("SELECT COUNT(*) AS count FROM model_routes WHERE node_id=?")
        .get(nodeId) as { count: number };
      if (routes.count > 0) {
        throw new NodeRemovalBlockedError(`节点仍被 ${routes.count} 条模型路由引用，请先移除这些路由`);
      }
      return this.sqlite.prepare("DELETE FROM nodes WHERE id=?").run(nodeId).changes > 0;
    });
    return remove.immediate();
  }

  saveNodeApiKey(nodeIdInput: unknown, apiKeyInput: unknown) {
    const nodeId = typeof nodeIdInput === "string" ? nodeIdInput.trim() : "";
    const apiKey = typeof apiKeyInput === "string" ? apiKeyInput.trim() : "";
    if (!nodeId || nodeId.length > 256 || !apiKey || apiKey.length > 4096 || /[\0\r\n]/.test(apiKey)) {
      throw new Error("节点 ID 或 llama-server API Key 无效");
    }
    if (this.isRelayMode()) throw new Error("代转发模式不接受管理员节点 Key；用户节点自行在本地配置并保护 API Key");
    const owner = this.sqlite.prepare("SELECT owner_user_id FROM nodes WHERE id=?").get(nodeId) as { owner_user_id: string | null } | undefined;
    if (owner?.owner_user_id) throw new Error("个人代转发节点的本地 Key 不能由管理员读取或修改");
    const updated = this.sqlite.prepare("UPDATE nodes SET upstream_api_key=? WHERE id=?")
      .run(encryptSecret(apiKey, this.secret), nodeId);
    if (!updated.changes) throw new Error("节点不存在，请先让节点连接到服务器");
    return { nodeId, keyConfigured: true };
  }

  async verifyNodeApiKey(nodeIdInput: unknown): Promise<{ nodeId: string; valid: boolean }> {
    const nodeId = typeof nodeIdInput === "string" ? nodeIdInput.trim() : "";
    if (!nodeId || nodeId.length > 256) throw new Error("节点 ID 无效");
    if (this.isRelayMode()) throw new Error("代转发模式不验证用户本地节点 Key");
    const row = this.sqlite.prepare("SELECT upstream_api_key,owner_user_id FROM nodes WHERE id=?")
      .get(nodeId) as { upstream_api_key: string | null; owner_user_id: string | null } | undefined;
    if (!row) throw new Error("节点不存在");
    if (row.owner_user_id) throw new Error("个人代转发节点的本地 Key 不能由管理员验证");
    if (!row.upstream_api_key) throw new Error("请先为节点配置 llama-server API Key");
    let valid: boolean;
    try {
      valid = await this.tunnel.validateUpstreamKey(decryptSecret(row.upstream_api_key, this.secret), nodeId);
    } catch (error) {
      if (error instanceof RelayError && error.statusCode === 503) throw error;
      throw new RelayError("节点未响应 Key 验证，请确认节点在线并更新桌面端桥接程序", 503);
    }
    return { nodeId, valid };
  }

  clearNodeApiKey(nodeIdInput: unknown): boolean {
    const nodeId = typeof nodeIdInput === "string" ? nodeIdInput.trim() : "";
    if (!nodeId || nodeId.length > 256) return false;
    if (this.isRelayMode()) throw new Error("代转发模式不接受管理员节点 Key 管理");
    const clear = this.sqlite.transaction(() => {
      const node = this.sqlite.prepare("SELECT id,owner_user_id FROM nodes WHERE id=?").get(nodeId) as
        { id: string; owner_user_id: string | null } | undefined;
      if (!node) return false;
      if (node.owner_user_id) throw new Error("个人代转发节点的本地 Key 不能由管理员清除");
      const dependent = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM model_routes
        WHERE node_id=? AND enabled=1 AND upstream_key=''`).get(nodeId) as { count: number };
      if (dependent.count > 0) throw new NodeKeyInUseError(dependent.count);
      return this.sqlite.prepare("UPDATE nodes SET upstream_api_key=NULL WHERE id=?").run(nodeId).changes > 0;
    });
    return clear.immediate();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
