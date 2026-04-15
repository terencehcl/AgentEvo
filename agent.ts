// agent.ts - AgentEVO Version 0（啟動版）
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { join } from "path";

const getConfig = () => ({
  WORKDIR: process.env.TEST_MODE ? "/tmp/agent-test" : "/workspace",
  HISTORY_FILE: process.env.TEST_MODE ? "/tmp/agent-test/agent-history.json" : "/workspace/agent-history.json",
  KB_DIR: process.env.TEST_MODE ? "/tmp/agent-test/kb" : "/workspace/kb",
  BACKUP_DIR: process.env.TEST_MODE ? "/tmp/agent-test/backups" : "/workspace/backups",
  EVO_VERSION_FILE: process.env.TEST_MODE ? "/tmp/agent-test/AGENT_EVO_VERSION.txt" : "/workspace/AGENT_EVO_VERSION.txt",
  MODEL: process.env.LLM_MODEL || "gemma4:e4b",
  MAX_RETRIES: 3,
  TARGET_VERSION: 10,   // 最終目標版本
});

const CONFIG = getConfig();

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

let history: any[] = [];
let isRecovering = false;
let currentEvoVersion = 0;

// For testing: allow injecting mocks
let mockSendTelegram: ((text: string) => Promise<void>) | null = null;
let mockCallLLM: (() => Promise<string>) | null = null;

export function setMocks(sendTg: (text: string) => Promise<void>, callLlm: () => Promise<string>) {
  mockSendTelegram = sendTg;
  mockCallLLM = callLlm;
}

// ==================== Utils ====================
export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getLatestBackup(): string | null {
  ensureDir(CONFIG.BACKUP_DIR);
  const files = readdirSync(CONFIG.BACKUP_DIR)
    .filter(f => f.startsWith("agent.ts."))
    .sort()
    .reverse();
  return files.length ? join(CONFIG.BACKUP_DIR, files[0]!) : null;
}

export function backupCurrentCode(reason: string = "manual") {
  ensureDir(CONFIG.BACKUP_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${CONFIG.BACKUP_DIR}/agent.ts.${reason}.${timestamp}.backup`;
  try {
    copyFileSync(`${CONFIG.WORKDIR}/agent.ts`, backupPath);
    console.log(`💾 備份完成: ${backupPath}`);
    return backupPath;
  } catch (e) { console.error("備份失敗", e); }
  return null;
}

export async function sendTelegram(text: string) {
  if (mockSendTelegram) return mockSendTelegram(text);
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch { }
}

// ==================== Version Management ====================
export function getCurrentEvoVersion(): number {
  if (existsSync(CONFIG.EVO_VERSION_FILE)) {
    return parseInt(readFileSync(CONFIG.EVO_VERSION_FILE, "utf-8").trim());
  }
  return 0; // 預設為 Version 0
}

export function setEvoVersion(version: number) {
  writeFileSync(CONFIG.EVO_VERSION_FILE, version.toString());
  currentEvoVersion = version;
  console.log(`📌 AgentEVO Version 升級為 v${version}`);
}

// ==================== 自動 Rollback 核心函數 ====================
export async function autoRollbackIfCrashed() {
  const lastOkFile = `${CONFIG.WORKDIR}/.last-run.ok`;
  const isLastRunOk = existsSync(lastOkFile);

  if (isLastRunOk) {
    console.log("✅ 上次正常運行，無需 rollback");
    return false;
  }

  console.log("🚨 偵測到上次崩潰！開始自動 rollback...");

  const latestBackup = getLatestBackup();
  if (!latestBackup) {
    console.log("⚠️ 沒有備份可用，無法 rollback");
    await sendTelegram("🚨 **嚴重：上次崩潰，但沒有備份可用！**");
    return false;
  }

  // 備份目前壞掉的版本（供診斷）
  backupCurrentCode("crashed-before-rollback");

  // 執行 rollback
  try {
    copyFileSync(latestBackup, `${CONFIG.WORKDIR}/agent.ts`);
    console.log(`♻️ 已自動 rollback 到: ${latestBackup}`);
    await sendTelegram(`♻️ **自動 Rollback 成功**\n已恢復上一個穩定版本\n壞版本已保存為 crashed-before-rollback`);
    return true;
  } catch (e) {
    console.error("Rollback 失敗", e);
    await sendTelegram("❌ Rollback 失敗！");
    return false;
  }
}

// ==================== LLM Layer (防崩潰) ====================
export async function callLLM(): Promise<string> {
  if (mockCallLLM) return mockCallLLM();
  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(process.env.LLM_URL || "http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.MODEL,
          messages: history,
          stream: false,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { message?: { content: string } };
      return data.message?.content || "[Empty response]";
    } catch (err: any) {
      if (attempt === CONFIG.MAX_RETRIES) {
        await sendTelegram(`🚨 LLM 呼叫失敗 ${CONFIG.MAX_RETRIES} 次`);
        return `[ERROR] LLM failed`;
      }
      await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  return "[ERROR]";
}

// ==================== 最終版 SYSTEM_PROMPT（已加入版本進化規則） ====================
export function getSystemPrompt(): string {
  return `你現在是 **AgentEVO** 自我進化系統。

當前版本：AgentEVO Version ${currentEvoVersion}
最終目標：AgentEVO Version 10（在 Podman sandbox 運行、極易安裝、擁有市面上所有強大功能：TDD、知識庫、上網搜尋、工具擴展、多檔案分層結構、自動 rollback 等）

=== 版本進化規則（嚴格遵守）===
1. 你現在是 **Version 0**（基礎穩定版）
2. 只有當你認為目前版本「已完美、穩定、不會輕易崩潰」時，才可以執行「完成當前版本」動作。
3. 完成當前版本的動作是：
   - 總結本版本的所有優點與已知問題（寫成 VERSION_SUMMARY.md）
   - 產生下一個版本的完整程式碼：agent-v${currentEvoVersion + 1}.ts
   - 在 agent-v${currentEvoVersion + 1}.ts 裡面寫明它是 AgentEVO Version ${currentEvoVersion + 1}
   - 使用 git tag v${currentEvoVersion}
   - 最後發 Telegram 通知：「AgentEVO v${currentEvoVersion} 已完成，v${currentEvoVersion + 1} 已產生」

4. 完成 v0 後，**Version 0 不再繼續自我修改**（凍結）。
5. 從 v1 開始，每個版本都重複以上流程，直到 v10 為最終版。

=== 核心規則（永遠遵守）===
- 只能用 Action: exec 格式回應
- 積極使用分層架構思維（Config → Utils → Memory → LLM → Executor → Tools）
- 優先 TDD + git + Telegram 通知
- 每次重大修改前先備份 + rollback 保護
- 逐步把單檔案升級成完整多檔案分層結構

現在開始：
如果你是 Version 0，請先探索環境、確認自己是 v0、發 Telegram「AgentEVO v0 已啟動」，然後開始打造完美 v0。
當你認為 v0 已完美時，執行「完成版本」流程，產生 v1。

Thought → Action: exec → Observation → 繼續循環`;
}

// ==================== Main ====================
async function main() {
  ensureDir(CONFIG.WORKDIR);
  ensureDir(CONFIG.BACKUP_DIR);
  ensureDir(CONFIG.KB_DIR);

  currentEvoVersion = getCurrentEvoVersion();

  // Git 初始化
  if (!existsSync(`${CONFIG.WORKDIR}/.git`)) {
    execSync("git init && git config user.name 'AgentEVO' && git config user.email 'evobot@self.dev'", { cwd: CONFIG.WORKDIR });
  }

  // === 關鍵：自動 Rollback ===
  const didRollback = await autoRollbackIfCrashed();

  // 載入歷史
  loadHistory();

  // 標記這次啟動正常
  writeFileSync(`${CONFIG.WORKDIR}/.last-run.ok`, new Date().toISOString());

  console.log(`🚀 AgentEVO Version ${currentEvoVersion} 已啟動（目標 v${CONFIG.TARGET_VERSION}）`);
  await sendTelegram(`🚀 **AgentEVO v${currentEvoVersion} 已啟動**\n目標：v${CONFIG.TARGET_VERSION}\n自動 Rollback 機制已開啟`);

  while (true) {
    if (isRecovering) { await new Promise(r => setTimeout(r, 3000)); continue; }

    const response = await callLLM();

    console.log("\n🤖 AgentEVO v" + currentEvoVersion + ":", response.substring(0, 350) + "...");

    const shouldContinue = await handleResponse(response);
    if (!shouldContinue) break;
  }
}

// ==================== Memory Layer ====================
export function loadHistory() {
  if (existsSync(CONFIG.HISTORY_FILE)) {
    history = JSON.parse(readFileSync(CONFIG.HISTORY_FILE, "utf-8"));
  } else {
    history = [{ role: "system", content: getSystemPrompt() }];
  }
}

export function saveHistory() {
  writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ==================== Executor Layer ====================
export async function executeCommand(cmd: string): Promise<string> {
  console.log("💻 Exec:", cmd);
  try {
    const output = execSync(cmd, {
      cwd: CONFIG.WORKDIR,
      encoding: "utf-8",
      shell: process.platform === "win32" ? "cmd" : "/bin/bash",
      timeout: 180000,
    });
    return output || "✅ done";
  } catch (e: any) {
    const err = `${e.stdout || ""}\n${e.stderr || e.message}`.trim();
    await sendTelegram(`❌ **執行失敗**\n\`\`\`bash\n${cmd}\n\`\`\`\nError: \`${err.slice(0, 500)}\``);
    return `❌ ${err}`;
  }
}

// ==================== Response Handler ====================
export async function handleResponse(response: string): Promise<boolean> {
  const match = response.match(/Action:\s*exec\s*\nCommand:\s*```(?:bash)?\n?([\s\S]+?)```/i);

  if (match && match[1]) {
    const cmd = match[1].trim();

    // 修改自己前強制備份
    if (cmd.includes("agent.ts") && (cmd.includes("cat >") || cmd.includes(">") || cmd.includes("echo "))) {
      backupCurrentCode("pre-self-modify");
    }

    const result = await executeCommand(cmd);

    history.push({ role: "assistant", content: response });
    history.push({ role: "user", content: `Observation:\n${result}` });
    saveHistory();
    return true;
  }
  else if (response.includes("Final Answer") || response.includes("任務完成")) {
    await sendTelegram(`✅ **AgentEVO v${currentEvoVersion} Final Answer**\n${response}`);
    return false; // stop
  }
  else if (response.includes("NEED_HUMAN")) {
    await sendTelegram(`🆘 **v${currentEvoVersion} 需要人類**\n${response}`);
    return true; // continue
  }
  return true; // continue
}

// ==================== 全域最後防線 ====================
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  backupCurrentCode("uncaught-crash");
  writeFileSync("/workspace/last-error.log", err.stack || String(err));
  sendTelegram(`💥 嚴重崩潰！已自動備份壞版本\n${err.message}`);
  process.exit(1); // Podman 會自動重啟
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  backupCurrentCode("unhandled-rejection");
  sendTelegram(`💥 Promise 錯誤！已備份\n${reason}`);
});

main().catch((err) => {
  backupCurrentCode("main-crash");
  console.error(err);
});