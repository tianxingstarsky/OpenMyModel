import * as readline from "readline";
import { loadConfig, saveConfig } from "./config";
import { hashPassword, verifyAdminPassword } from "./services/auth";
import { initDatabase, nodes, db } from "./db/schema";
import { eq } from "drizzle-orm";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q = (p: string) => new Promise<string>(r => rl.question(p, a => r(a.trim())));

function hr() { console.log("──────────────────────────────────────────────"); }

async function checkNodeStatus() {
  initDatabase();
  const online = db.select().from(nodes).where(eq(nodes.isOnline, true)).all();
  if (online.length === 0) {
    console.log("  节点状态: 无在线节点");
    console.log("  等待本地算力端 (Flutter) 通过 WebSocket 连接...");
  } else {
    console.log(`  在线节点: ${online.length} 个`);
    for (const n of online) {
      console.log(`    - ${n.name} | 模型: ${n.modelName || "未知"} | 最后心跳: ${n.lastHeartbeat || "N/A"}`);
    }
  }
  console.log("");
}

async function showConfig() {
  const cfg = loadConfig();
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║          OutMyModel 当前配置                  ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  域名:    ${(cfg.domain || "未设置").padEnd(35)}║`);
  console.log(`║  端口:    ${String(cfg.port).padEnd(35)}║`);
  console.log(`║  已初始化: ${(cfg.setupComplete ? "是" : "否").padEnd(35)}║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  await checkNodeStatus();
}

async function changeDomain() {
  const cfg = loadConfig();
  console.log(`当前域名: ${cfg.domain || "未设置"}`);
  const d = await q("新域名 (回车保持): ");
  if (d) { cfg.domain = d; saveConfig(cfg); console.log("域名已更新"); }
}

async function changePort() {
  const cfg = loadConfig();
  console.log(`当前端口: ${cfg.port}`);
  const p = await q("新端口 (回车保持): ");
  if (p) { const port = parseInt(p) || 3000; cfg.port = port; saveConfig(cfg); console.log(`端口已更新: ${port}`); }
}

async function resetPassword() {
  const cfg = loadConfig();
  console.log("重置管理员密码");
  const old = await q("当前密码 (验证身份): ");
  if (!verifyAdminPassword(old)) { console.log("密码错误"); return; }
  let pw = "";
  while (pw.length < 6) { pw = await q("新密码 (至少6字符): "); if (pw.length < 6) console.log("太短"); }
  const pw2 = await q("确认新密码: ");
  if (pw !== pw2) { console.log("两次不一致"); return; }
  cfg.passwordHash = hashPassword(pw);
  saveConfig(cfg);
  console.log("密码已重置");
}

async function setupWizard() {
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       OutMyModel 云后端 - 初始化向导          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  const cfg = loadConfig();

  // Domain
  console.log("Step 1: 域名 (如 aiapi.topofmoon.com)");
  let domain = await q(`域名 [${cfg.domain || "localhost"}]: `);
  if (!domain) domain = cfg.domain || "localhost";

  // Password
  console.log("");
  console.log("Step 2: 管理员密码 (至少6字符，用于前端连接)");
  let password = "";
  while (password.length < 6) { password = await q("密码: "); if (password.length < 6) console.log("太短"); }
  const confirm = await q("确认密码: ");
  if (password !== confirm) { console.log("不一致，退出"); return; }

  // Port
  console.log("");
  console.log("Step 3: 端口");
  const ps = await q(`端口 [${cfg.port || 3000}]: `);
  const port = parseInt(ps) || cfg.port || 3000;

  cfg.domain = domain;
  cfg.passwordHash = hashPassword(password);
  cfg.port = port;
  cfg.setupComplete = true;
  saveConfig(cfg);

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║          配置完成                             ║");
  console.log(`║  域名: ${domain.padEnd(37)}║`);
  console.log(`║  端口: ${String(port).padEnd(37)}║`);
  console.log("║  运行 npm start 启动服务                      ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
}

async function main() {
  initDatabase();
  const args = process.argv.slice(2);

  // Quick status check
  if (args.includes("--status") || args.includes("status")) {
    const cfg = loadConfig();
    console.log(`OutMyModel 云后端 | 域名: ${cfg.domain || "未设置"} | 端口: ${cfg.port}`);
    await checkNodeStatus();
    rl.close();
    return;
  }

  await showConfig();

  const cfg = loadConfig();
  if (!cfg.setupComplete) {
    console.log("首次运行，进入初始化向导...");
    await setupWizard();
    rl.close();
    return;
  }

  // Menu loop
  while (true) {
    console.log("管理菜单:");
    console.log("  1. 查看配置");
    console.log("  2. 修改域名");
    console.log("  3. 修改端口");
    console.log("  4. 重置密码");
    console.log("  5. 重新初始化 (全部重设)");
    console.log("  6. 查看节点状态");
    console.log("  0. 退出");
    console.log("");

    const choice = await q("请选择 [0-6]: ");

    switch (choice) {
      case "1": await showConfig(); break;
      case "2": await changeDomain(); break;
      case "3": await changePort(); break;
      case "4": await resetPassword(); break;
      case "5": await setupWizard(); break;
      case "6": await checkNodeStatus(); break;
      case "0": console.log("再见"); rl.close(); return;
      default: console.log("无效选项");
    }
    console.log("");
  }
}

main().catch(console.error);
