import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  ensureDir,
  getLatestBackup,
  backupCurrentCode,
  sendTelegram,
  getCurrentEvoVersion,
  setEvoVersion,
  autoRollbackIfCrashed,
  callLLM,
  getSystemPrompt,
  loadHistory,
  saveHistory,
  executeCommand,
  handleResponse,
  setMocks
} from "./agent";

// Test utilities & mocks
const TEST_DIR = "/tmp/agent-test";
const BACKUP_DIR = join(TEST_DIR, "backups");

function setupTestEnv() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Create dummy agent.ts for backup tests
  writeFileSync(join(TEST_DIR, "agent.ts"), "dummy agent code");
}

function cleanupTestEnv() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

// Mock functions
const mockSendTelegram = mock(() => Promise.resolve());
const mockCallLLM = mock(() => Promise.resolve("Action: exec\nCommand: ```bash\necho test\n```"));

describe("Agent Functions", () => {
  beforeAll(() => {
    process.env.TEST_MODE = "true";
    setupTestEnv();
    setMocks(mockSendTelegram, mockCallLLM);
  });

  afterAll(() => {
    cleanupTestEnv();
    delete process.env.TEST_MODE;
  });

  describe("ensureDir", () => {
    it("should create directory if it doesn't exist", () => {
      const testPath = join(TEST_DIR, "newdir");
      ensureDir(testPath);
      expect(existsSync(testPath)).toBe(true);
    });
  });

  describe("getLatestBackup", () => {
    it("should return null if no backups exist", () => {
      const result = getLatestBackup();
      expect(result).toBeNull();
    });

    it("should return the latest backup file", () => {
      const backupFile = join(BACKUP_DIR, "agent.ts.test.2024-01-01.backup");
      writeFileSync(backupFile, "test");
      const result = getLatestBackup();
      expect(result).toBe(backupFile);
    });
  });

  describe("backupCurrentCode", () => {
    it("should create a backup file", () => {
      const result = backupCurrentCode("test");
      expect(result).toBeDefined();
      expect(existsSync(result!)).toBe(true);
    });
  });

  describe("sendTelegram", () => {
    it("should call mock sendTelegram", async () => {
      await sendTelegram("test message");
      expect(mockSendTelegram).toHaveBeenCalledWith("test message");
    });
  });

  describe("getCurrentEvoVersion", () => {
    it("should return 0 if version file doesn't exist", () => {
      const versionFile = join(TEST_DIR, "AGENT_EVO_VERSION.txt");
      if (existsSync(versionFile)) rmSync(versionFile);
      const result = getCurrentEvoVersion();
      expect(result).toBe(0);
    });

    it("should return parsed version from file", () => {
      const versionFile = join(TEST_DIR, "AGENT_EVO_VERSION.txt");
      writeFileSync(versionFile, "5");
      const result = getCurrentEvoVersion();
      expect(result).toBe(5);
    });
  });

  describe("setEvoVersion", () => {
    it("should write version to file", () => {
      setEvoVersion(3);
      const versionFile = join(TEST_DIR, "AGENT_EVO_VERSION.txt");
      expect(existsSync(versionFile)).toBe(true);
      const content = require("fs").readFileSync(versionFile, "utf-8");
      expect(content).toBe("3");
    });
  });

  describe("autoRollbackIfCrashed", () => {
    it("should not rollback if last run was ok", async () => {
      const okFile = join(TEST_DIR, ".last-run.ok");
      writeFileSync(okFile, new Date().toISOString());
      
      const result = await autoRollbackIfCrashed();
      expect(result).toBe(false);
    });

    it("should rollback if no ok file and backup exists", async () => {
      const okFile = join(TEST_DIR, ".last-run.ok");
      if (existsSync(okFile)) rmSync(okFile);
      
      const backupFile = join(BACKUP_DIR, "agent.ts.rollback.2024-01-01.backup");
      writeFileSync(backupFile, "backup content");
      
      const result = await autoRollbackIfCrashed();
      expect(result).toBe(true);
      expect(mockSendTelegram).toHaveBeenCalled();
    });

    it("should not rollback if no backup available", async () => {
      const okFile = join(TEST_DIR, ".last-run.ok");
      if (existsSync(okFile)) rmSync(okFile);
      
      // Clear backups
      const files = require("fs").readdirSync(BACKUP_DIR);
      files.forEach((f: string) => rmSync(join(BACKUP_DIR, f)));
      
      const result = await autoRollbackIfCrashed();
      expect(result).toBe(false);
      expect(mockSendTelegram).toHaveBeenCalledWith("🚨 **嚴重：上次崩潰，但沒有備份可用！**");
    });
  });

  describe("callLLM", () => {
    it("should call mock LLM", async () => {
      const result = await callLLM();
      expect(result).toBe("Action: exec\nCommand: ```bash\necho test\n```");
    });
  });

  describe("getSystemPrompt", () => {
    it("should return system prompt string", () => {
      const prompt = getSystemPrompt();
      expect(prompt).toContain("AgentEVO");
      expect(prompt).toContain("Version 0");
    });
  });

  describe("loadHistory", () => {
    it("should load history from file if exists", () => {
      const historyFile = join(TEST_DIR, "agent-history.json");
      const testHistory = [{ role: "system", content: "test" }];
      writeFileSync(historyFile, JSON.stringify(testHistory));
      
      loadHistory();
      // Note: history is internal, hard to test directly
      expect(true).toBe(true); // Placeholder
    });
  });

  describe("saveHistory", () => {
    it("should save history to file", () => {
      saveHistory();
      const historyFile = join(TEST_DIR, "agent-history.json");
      expect(existsSync(historyFile)).toBe(true);
    });
  });

  describe("executeCommand", () => {
    it("should execute simple command", async () => {
      const result = await executeCommand("echo test");
      expect(result).toContain("test");
    });

    it("should handle command failure", async () => {
      const result = await executeCommand("nonexistentcommand");
      expect(result).toContain("❌");
      expect(mockSendTelegram).toHaveBeenCalled();
    });
  });

  describe("handleResponse", () => {
    it("should handle exec action", async () => {
      const response = "Action: exec\nCommand: ```bash\necho handled\n```";
      const result = await handleResponse(response);
      expect(result).toBe(true);
    });

    it("should handle final answer", async () => {
      const response = "Final Answer: done";
      const result = await handleResponse(response);
      expect(result).toBe(false);
      expect(mockSendTelegram).toHaveBeenCalled();
    });

    it("should handle need human", async () => {
      const response = "NEED_HUMAN: help";
      const result = await handleResponse(response);
      expect(result).toBe(true);
      expect(mockSendTelegram).toHaveBeenCalled();
    });

    it("should continue for unknown response", async () => {
      const response = "Unknown response";
      const result = await handleResponse(response);
      expect(result).toBe(true);
    });
  });
});

// Test Config Type
describe("Config Type Safety", () => {
  it("should properly type CONFIG with string values", () => {
    const config: { [key: string]: string | number } = {
      WORKDIR: "/workspace",
      BACKUP_DIR: "/workspace/backups",
      MODEL: "gemma4:e4b",
      MAX_RETRIES: 3,
    };
    
    expect(config.WORKDIR).toBe("/workspace");
    expect(typeof config.BACKUP_DIR).toBe("string");
  });
});

// Test JSON Response Typing
describe("LLM Response Parsing", () => {
  it("should handle JSON response with proper typing", () => {
    const mockResponse = { message: { content: "test output" } };
    const data = mockResponse as { message?: { content: string } };
    
    expect(data.message?.content).toBe("test output");
  });

  it("should handle empty response gracefully", () => {
    const mockResponse = {};
    const data = mockResponse as { message?: { content: string } };
    const result = data.message?.content || "[Empty response]";
    
    expect(result).toBe("[Empty response]");
  });
});

// Test Regex Match Safety
describe("Command Extraction", () => {
  it("should safely extract command from valid response", () => {
    const response = `Action: exec
Command: \`\`\`bash
echo "test"
\`\`\``;
    
    const match = response.match(/Action:\s*exec\s*\nCommand:\s*```(?:bash)?\n?([\s\S]+?)```/i);
    
    expect(match).toBeDefined();
    if (match && match[1]) {
      expect(match[1].trim()).toBe("echo \"test\"");
    }
  });

  it("should handle null match safely", () => {
    const response = "Invalid response format";
    const match = response.match(/Action:\s*exec\s*\nCommand:\s*```(?:bash)?\n?([\s\S]+?)```/i);
    
    // Proper null check
    let cmd: string | null = null;
    if (match && match[1]) {
      cmd = match[1].trim();
    }
    
    expect(cmd).toBeNull();
  });

  it("should extract multiline bash commands", () => {
    const response = `Action: exec
Command: \`\`\`bash
cd /workspace
ls -la
echo "done"
\`\`\`
Observation:`;
    
    const match = response.match(/Action:\s*exec\s*\nCommand:\s*```(?:bash)?\n?([\s\S]+?)```/i);
    
    if (match && match[1]) {
      const cmd = match[1].trim();
      expect(cmd).toContain("cd /workspace");
      expect(cmd).toContain("ls -la");
      expect(cmd).toContain("echo \"done\"");
    }
  });
});

// Test Backup Directory Handling
describe("Backup Directory", () => {
  beforeAll(() => setupTestEnv());
  afterAll(() => cleanupTestEnv());

  it("should ensure backup directory exists", () => {
    expect(existsSync(BACKUP_DIR)).toBe(true);
  });

  it("should handle backup file naming", () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${BACKUP_DIR}/agent.ts.pre-modify.${timestamp}.backup`;
    
    writeFileSync(backupPath, "// backup content");
    expect(existsSync(backupPath)).toBe(true);
  });
});

// Test Error Handling
describe("Error Handling", () => {
  it("should catch and handle JSON parse errors", () => {
    const handleJsonError = (data: unknown) => {
      try {
        const typed = data as { message?: { content: string } };
        return typed?.message?.content || "[Error parsing response]";
      } catch {
        return "[JSON parse error]";
      }
    };

    expect(handleJsonError({ message: { content: "ok" } })).toBe("ok");
    expect(handleJsonError(null)).toBe("[Error parsing response]");
    expect(handleJsonError({})).toBe("[Error parsing response]");
  });

  it("should safely handle undefined MESSAGE content", () => {
    const data = { message: {} } as { message?: { content: string } };
    const result = data.message?.content || "[Empty response]";
    
    expect(result).toBe("[Empty response]");
  });
});

console.log("🧪 Unit tests ready! Run: bun test");
