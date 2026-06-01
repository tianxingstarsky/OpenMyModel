import * as readline from "readline";
import { loadConfig, saveConfig, getConfigDir } from "./config";
import { hashPassword } from "./services/auth";

/**
 * CLI 初始化向导 (中文交互)
 * 首次运行时设置服务器域名和管理员密码
 * 用户不需要输入中文到命令行，只需输入英文/数字
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       OutMyModel 云后端 - 初始化向导          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");

  const existingConfig = loadConfig();

  if (existingConfig.setupComplete) {
    console.log("检测到已有配置:");
    console.log(`  域名: ${existingConfig.domain}`);
    console.log(`  端口: ${existingConfig.port}`);
    console.log("");

    const reconfigure = await question("是否重新配置? (yes/no, default: no): ");
    if (reconfigure.toLowerCase() !== "yes" && reconfigure.toLowerCase() !== "y") {
      console.log("保持现有配置，退出向导。");
      rl.close();
      return;
    }
    console.log("");
  }

  // Step 1: 设置域名
  console.log("━━━ Step 1: 服务器域名配置 ━━━");
  console.log("请输入此云服务的域名 (例如: aiapi.topofmoon.com)");
  console.log("此域名将用于前端连接和 API 文档中的示例地址");
  console.log("");

  let domain = await question("域名 (default: localhost): ");
  if (!domain) domain = "localhost";

  // Step 2: 设置管理员密码
  console.log("");
  console.log("━━━ Step 2: 管理员密码设置 ━━━");
  console.log("请设置管理员密码 (用于前端连接认证)");
  console.log("密码要求: 至少 6 个字符");
  console.log("");

  let password = "";
  while (password.length < 6) {
    password = await question("管理员密码 (至少6字符): ");
    if (password.length < 6) {
      console.log("  -> 密码太短，至少需要 6 个字符");
    }
  }

  const confirmPassword = await question("确认密码: ");
  if (password !== confirmPassword) {
    console.log("  -> 两次密码不一致，请重新运行向导");
    rl.close();
    return;
  }

  // Step 3: 设置端口
  console.log("");
  console.log("━━━ Step 3: 服务端口设置 ━━━");

  const portStr = await question("HTTP 端口 (default: 3000): ");
  const port = parseInt(portStr) || 3000;

  // 保存配置
  const passwordHash = hashPassword(password);
  const config = {
    domain,
    password: "",        // 不存储明文密码
    passwordHash,
    port,
    setupComplete: true,
  };

  saveConfig(config);

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║          配置完成!                            ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  域名:    ${domain.padEnd(35)}║`);
  console.log(`║  端口:    ${String(port).padEnd(35)}║`);
  console.log(`║  密码:    ${"*".repeat(password.length).padEnd(35)}║`);
  console.log("╠══════════════════════════════════════════════╣");
  console.log("║  运行 npm start 启动服务                      ║");
  console.log("║  在前端输入域名和密码即可连接                  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");

  rl.close();
}

main().catch(console.error);