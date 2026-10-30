import { describe, it, before, after, beforeEach } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@mariozechner/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
} from "../pi-extension/subagents/session.ts";

import { shellEscape } from "../pi-extension/subagents/tmux.ts";
import { buildStartupDeadlineCommand } from "../pi-extension/subagents/startup.ts";
import {
  appendExplicitLoadoutArgs,
  authorizeToolCall,
  createExplicitLoadoutSnapshot,
  fingerprintExtension,
  resolveExplicitLoadout,
  snapshotToolProviders,
  validateExplicitLoadoutSnapshot,
  validateToolProviderGrants,
} from "../pi-extension/subagents/loadout.ts";
import { fingerprintMcpServerConfig, resolveMcpServerIdentities } from "../pi-extension/subagents/mcp-identity.ts";
import { createToolPolicyHandlers } from "../pi-extension/subagents/tool-policy.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/tmux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function chooseFromCustomModelPicker(index: number | number[] = 0) {
  let callIndex = 0;
  return async (factory: any, options?: { overlay?: boolean }) => {
    assert.notEqual(options?.overlay, true, "the model picker should replace the input, not open as an overlay");
    let selected: string | undefined;
    const actions: Record<string, string> = {
      "tui.select.up": "UP",
      "tui.select.down": "DOWN",
      "tui.select.confirm": "ENTER",
      "tui.select.cancel": "ESC",
    };
    const component = factory(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
      { matches: (data: string, action: string) => data === actions[action] },
      (value: string | undefined) => {
        selected = value;
      },
    );
    component.render(120);
    const moves = Array.isArray(index) ? (index[callIndex] ?? 0) : index;
    callIndex++;
    for (let i = 0; i < Math.abs(moves); i++) component.handleInput(moves < 0 ? "UP" : "DOWN");
    component.handleInput("ENTER");
    return selected;
  };
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(agentsDir: string, name: string, frontmatter: string, body = "You are a test agent.") {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,safe_bash,web_search,subagent,ask_question",
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
      assert.equal(statSync(sf + ".loadout.json").mode & 0o777, 0o600);
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(findLastAssistantMessage(entries), "Subagent error: Anthropic 529 Overloaded after 3 retries");
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(
        entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile),
        false,
      );
      assert.equal(
        entries.some((entry) => entry.type === "message"),
        false,
      );
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(targetFile, [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n");

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (
      id: string,
      opts: {
        model?: string;
        tools?: string[];
        usage?: Record<string, unknown>;
      },
    ) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 1000,
            cacheWrite: 200,
            totalTokens: 1350,
            cost: { total: 0.01 },
          },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: {
            input: 30,
            output: 70,
            cacheRead: 2000,
            cacheWrite: 0,
            totalTokens: 3500,
            cost: { total: 0.02 },
          },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", {
          model: "claude-sonnet-4-6",
          usage: { totalTokens: 10, cost: { total: 0 } },
        }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2) + "\n");

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(() => parseStatusConfig({ status: { enabled: "false" } }), /status\.enabled must be a boolean/);
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2) + "\n");

      assert.throws(() => loadStatusConfig(configPath, examplePath), /Invalid JSON in subagent config .*config\.json/);
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      5_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: "present",
        updatedAt: 96_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 96_000,
        latestEvent: "agent_end",
      },
      96_000,
    );
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 5_000,
      },
      5_000,
    );
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 10_000,
        activityLabel: "bash",
      },
      10_000,
    );

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 3,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_001,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      11_000,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      21_000,
    );
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(
      stale,
      {
        snapshot: "present",
        updatedAt: 20_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 20_000,
        activityLabel: "bash",
      },
      22_000,
    );
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(
      sameTimestamp,
      {
        snapshot: "present",
        sequence: 2,
        updatedAt: 25_000,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 25_000,
        activityLabel: "streaming",
      },
      25_000,
    );
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;
  const testContract = "a".repeat(64);

  it("loads the Pi-default fallback setting from agent frontmatter", () => {
    const dir = createTestDir();
    const agentsDir = join(dir, ".pi", "agents");
    writeAgentFile(agentsDir, "fallback-agent", ["name: fallback-agent", "fallback-model: pi-default"].join("\n"));
    try {
      const loaded = testApi.loadAgentDefaults("fallback-agent", dir);
      assert.equal(loaded?.fallbackModel, "pi-default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the parent model as a distinct fallback only when configured", () => {
    const resolve = testApi.resolveFallbackModel;
    const parent = { provider: "openai", id: "current-model" };
    assert.equal(resolve("pi-default", parent, "anthropic/preferred"), "openai/current-model");
    assert.equal(resolve(undefined, parent, "anthropic/preferred"), undefined);
    assert.equal(resolve("pi-default", undefined, "anthropic/preferred"), undefined);
    assert.equal(resolve("pi-default", parent, "openai/current-model"), undefined);
  });

  it("retries a failed configured model once with Pi default", async () => {
    const controller = new AbortController();
    const primary: any = {
      id: "primary",
      name: "fallback-agent",
      task: "do work",
      model: "anthropic/preferred",
      fallbackModel: "openai/current-model",
      abortController: controller,
    };
    const fallback: any = {
      ...primary,
      id: "fallback",
      model: "openai/current-model",
      modelSource: "Pi default fallback",
      fallbackModel: undefined,
    };
    const watched: any[] = [];
    const results = [
      {
        name: primary.name,
        task: primary.task,
        summary: "provider error",
        exitCode: 1,
        elapsed: 1,
        errorMessage: "402 credits",
      },
      { name: fallback.name, task: fallback.task, summary: "completed", exitCode: 0, elapsed: 2 },
    ];

    const result = await testApi.watchSubagentWithFallback(
      primary,
      controller.signal,
      async (model: string) => {
        assert.equal(model, "openai/current-model");
        return fallback;
      },
      async (running: any) => {
        watched.push(running.id);
        return results.shift();
      },
    );

    assert.deepEqual(watched, ["primary", "fallback"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /retried with Pi default openai\/current-model/);
  });

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        ["name: lineage-mode-test-agent", "model: anthropic/test-lineage", "session-mode: lineage-only"].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        ["name: interactive-true-test-agent", "model: anthropic/test-interactive-true", "interactive: true"].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        ["name: interactive-false-test-agent", "model: anthropic/test-interactive-false", "interactive: false"].join(
          "\n",
        ),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        ["name: interactive-unset-test-agent", "model: anthropic/test-interactive-unset"].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }), false);
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }), true);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}), true);
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null), true);
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true, interactive: true }),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: false }), false);
  });

  it("bundled scout/researcher/worker all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.fallbackModel, "pi-default", `${name} should retry with the Pi default model`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", () => {
    assert.equal(testApi.getToolExtensionPath("read"), undefined);
    assert.equal(testApi.getToolExtensionPath("bash"), undefined);
    const webSearchPath = testApi.getToolExtensionPath("web_search");
    // The global web-search extension is optional in isolated test environments.
    if (webSearchPath) assert.ok(webSearchPath.endsWith("web-search/index.ts"));
    assert.ok(testApi.getToolExtensionPath("safe_bash")?.endsWith("tools/safe-bash.ts"));
    // Spawning tools are registered by this extension itself.
    assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        ["name: invalid-mode-test-agent", "model: anthropic/test-invalid", "session-mode: sideways"].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }), "fork");
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }), {
      sessionMode: "lineage-only",
      seededSessionMode: "lineage-only",
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }), {
      sessionMode: "fork",
      seededSessionMode: "fork",
      inheritsConversationContext: true,
      taskDelivery: "direct",
    });
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(testApi.buildSubagentToolAllowlist("read,bash,web_search"), "read,bash,web_search,ask_question");
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("resolves an explicit codemode loadout with exact provider-bound grants", () => {
    const resolved = resolveExplicitLoadout(
      {
        extensions: ["builtin:codemode"],
        mcpServers: [],
        tools: ["read", "codemode"],
      },
      [{ name: "builtin:codemode", path: "builtin:codemode" }],
      [
        { name: "read", provider: "builtin:read", contractFingerprint: testContract },
        { name: "codemode", provider: "builtin:codemode", contractFingerprint: testContract },
      ],
    );

    assert.deepEqual(resolved, {
      extensions: [{ name: "builtin:codemode", path: "builtin:codemode", identity: "builtin:codemode" }],
      mcpServers: [],
      mcpServerFingerprints: [],
      toolProviders: [
        { name: "read", provider: "builtin:read", contractFingerprint: testContract },
        { name: "codemode", provider: "builtin:codemode", contractFingerprint: testContract },
      ],
    });
  });

  it("requires tools to come from a selected resource", () => {
    assert.throws(
      () =>
        resolveExplicitLoadout(
          { extensions: ["builtin:codemode"], mcpServers: [], tools: ["web_search"] },
          [{ name: "builtin:codemode", path: "builtin:codemode" }],
          [
            {
              name: "web_search",
              provider: "/extensions/web-search.ts",
              contractFingerprint: testContract,
            },
          ],
        ),
      /not provided by an explicitly selected resource/,
    );
  });

  it("grants an exact MCP tool only from its selected server", () => {
    const fingerprint = "a".repeat(64);
    const available = [
      {
        name: "mcp__selected__read",
        provider: "builtin:mcp",
        mcpServer: "selected",
        contractFingerprint: testContract,
      },
      {
        name: "mcp__other__read",
        provider: "builtin:mcp",
        mcpServer: "other",
        contractFingerprint: testContract,
      },
    ];
    const resolved = resolveExplicitLoadout(
      { extensions: [], mcpServers: ["selected"], tools: ["mcp__selected__read"] },
      [],
      available,
      [{ name: "selected", fingerprint }],
    );

    assert.deepEqual(resolved, {
      extensions: [],
      mcpServers: ["selected"],
      mcpServerFingerprints: [{ name: "selected", fingerprint }],
      toolProviders: [available[0]],
    });
    assert.throws(
      () =>
        resolveExplicitLoadout(
          { extensions: [], mcpServers: ["selected"], tools: ["mcp__other__read"] },
          [],
          available,
          [{ name: "selected", fingerprint }],
        ),
      /not provided by an explicitly selected resource/,
    );
    assert.throws(
      () =>
        resolveExplicitLoadout(
          { extensions: [], mcpServers: ["selected"], tools: ["mcp__selected__read"] },
          [],
          available,
        ),
      /no safe configuration identity/,
    );
  });

  it("rejects unscoped MCP proxy and resource tools", () => {
    for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "tool_search"]) {
      assert.throws(
        () =>
          resolveExplicitLoadout(
            { extensions: [], mcpServers: ["selected"], tools: [name] },
            [],
            [
              {
                name: "mcp__selected__read",
                provider: "builtin:mcp",
                mcpServer: "selected",
                contractFingerprint: testContract,
              },
              { name, provider: "builtin:mcp", contractFingerprint: testContract },
            ],
            [{ name: "selected", fingerprint: "a".repeat(64) }],
          ),
        /Generic MCP proxy\/search tool/,
      );
    }
  });

  it("validates selected MCP configuration and provider identity on resume", () => {
    const fingerprint = "b".repeat(64);
    const grant = {
      name: "mcp__selected__read",
      provider: "builtin:mcp",
      mcpServer: "selected",
      contractFingerprint: testContract,
    };
    const resolved = resolveExplicitLoadout(
      { extensions: [], mcpServers: ["selected"], tools: [grant.name] },
      [],
      [grant],
      [{ name: "selected", fingerprint }],
    );
    const snapshot = createExplicitLoadoutSnapshot(resolved, "1.4.0", [], []);
    const context = {
      runtimeVersion: "1.4.0",
      requirePinnedContracts: true,
      currentTools: [grant],
      currentMcpServers: [{ name: "selected", fingerprint }],
    };
    assert.doesNotThrow(() => validateExplicitLoadoutSnapshot(snapshot, context));
    assert.throws(
      () =>
        validateExplicitLoadoutSnapshot(snapshot, {
          ...context,
          currentMcpServers: [{ name: "selected", fingerprint: "c".repeat(64) }],
        }),
      /changed configuration identity/,
    );
    assert.throws(
      () =>
        validateExplicitLoadoutSnapshot(snapshot, {
          ...context,
          currentTools: [{ ...grant, mcpServer: "other" }],
        }),
      /changed provider or contract/,
    );
  });

  it("snapshots exact MCP server names from Pi tool namespaces", () => {
    const providers = snapshotToolProviders([
      {
        name: "mcp__selected_server__read",
        description: "Read a value.",
        parameters: { type: "object" },
        sourceInfo: { path: "builtin:mcp" },
        namespace: { name: "mcp__selected_server", aliases: ["selected-server"] },
      },
    ]);
    assert.equal(providers[0].mcpServer, "selected-server");
    assert.equal(providers[0].provider, "builtin:mcp");
    assert.match(providers[0].contractFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.throws(
      () =>
        snapshotToolProviders([
          {
            name: "mcp__selected_server__read",
            description: "Read a value.",
            parameters: { type: "object" },
            sourceInfo: { path: "builtin:mcp" },
            namespace: { aliases: ["selected-server", "selected_server"] },
          },
        ]),
      /unambiguous MCP server identity/,
    );
  });

  it("fingerprints safe MCP configuration without persisting secret values", () => {
    const first = fingerprintMcpServerConfig("selected", {
      command: "node",
      args: ["server.mjs", "--mode", "safe"],
      env: { API_TOKEN: "first-secret" },
      exposure: "direct",
    });
    const rotatedCredential = fingerprintMcpServerConfig("selected", {
      command: "node",
      args: ["server.mjs", "--mode", "safe"],
      env: { API_TOKEN: "second-secret" },
      exposure: "direct",
    });
    const changedConfig = fingerprintMcpServerConfig("selected", {
      command: "node",
      args: ["server.mjs", "--mode", "restricted"],
      env: { API_TOKEN: "second-secret" },
      exposure: "direct",
    });
    const changedWorkingDirectory = fingerprintMcpServerConfig(
      "selected",
      {
        command: "node",
        args: ["server.mjs", "--mode", "safe"],
        env: { API_TOKEN: "first-secret" },
        exposure: "direct",
      },
      "/tmp/another-project",
    );
    assert.equal(first, rotatedCredential, "secret values are excluded from the safe configuration identity");
    assert.notEqual(first, changedConfig, "non-secret server arguments are pinned");
    assert.notEqual(first, changedWorkingDirectory, "the effective stdio working directory is pinned");
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(first, /first-secret|second-secret/);
    assert.throws(
      () => fingerprintMcpServerConfig("selected", { command: "node", args: ["--api-key", "secret"] }),
      /secret-like arguments/,
    );
    assert.throws(
      () => fingerprintMcpServerConfig("selected", { command: "node", futureRuntimeOption: true }),
      /fields that cannot be safely fingerprinted/,
    );
  });

  it("rejects ambiguous MCP config sources instead of guessing the effective server", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const cwd = join(dir, "project");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { selected: { command: "node" } } }));
      writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { selected: { command: "node" } } }));
      assert.throws(
        () => resolveMcpServerIdentities(["selected"], { agentDir, cwd }),
        /ambiguous configuration sources/,
      );
    });
  });

  it("appends the built-in MCP runtime only for explicit MCP server selections", () => {
    const mcpParts: string[] = [];
    appendExplicitLoadoutArgs(
      mcpParts,
      {
        version: 1,
        runtimeVersion: "1.4.0",
        extensions: [],
        mcpServers: ["selected"],
        toolProviders: [],
        runnerFiles: [],
      },
      "mcp__selected__read",
      "/policy.ts",
      shellEscape,
    );
    assert.ok(mcpParts.includes("-e"));
    assert.ok(mcpParts.includes("'builtin:mcp'"));
    assert.equal(mcpParts.includes("--no-mcp"), false);

    const noMcpParts: string[] = [];
    appendExplicitLoadoutArgs(
      noMcpParts,
      { version: 1, runtimeVersion: "1.4.0", extensions: [], mcpServers: [], toolProviders: [], runnerFiles: [] },
      "read",
      "/policy.ts",
      shellEscape,
    );
    assert.ok(noMcpParts.includes("--no-mcp"));
  });

  it("registers exact subagent extension names with a stable identity", () => {
    withTempDir((dir) => {
      const path = join(dir, "extension.ts");
      writeFileSync(path, "export default () => undefined;", "utf8");
      const name = `test-resource-${Date.now()}`;
      assert.throws(() => testApi.registerSubagentExtension(`${name}-missing-identity`, path, ""), /Invalid identity/);
      assert.doesNotThrow(() => testApi.registerSubagentExtension(name, path, "test-resource@1"));
      assert.doesNotThrow(() => testApi.registerSubagentExtension(name, path, "test-resource@1"));
      assert.throws(() => testApi.registerSubagentExtension(name, path, "test-resource@2"), /already registered/);
    });
  });

  it("terminates an explicit child that does not signal startup readiness by its deadline", () => {
    withTempDir((dir) => {
      const readyPath = join(dir, "ready");
      const exitPath = join(dir, "session.exit");
      const command = buildStartupDeadlineCommand({
        command: "exec sleep 5",
        readyFile: readyPath,
        exitFile: exitPath,
        timeoutMs: 100,
        escape: shellEscape,
      });
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(exitPath, "utf8")), {
        type: "error",
        errorMessage: "Explicit subagent startup timed out before loadout readiness.",
      });
    });
  });

  it("stops waiting once an explicit child signals startup readiness", () => {
    withTempDir((dir) => {
      const readyPath = join(dir, "ready");
      const exitPath = join(dir, "session.exit");
      const command = buildStartupDeadlineCommand({
        command: `printf ready > ${shellEscape(readyPath)}; exec true`,
        readyFile: readyPath,
        exitFile: exitPath,
        timeoutMs: 1000,
        escape: shellEscape,
      });
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(readyPath, "utf8"), "ready");
      assert.equal(existsSync(exitPath), false);
    });
  });

  it("rejects registered extensions without a trusted identity", () => {
    withTempDir((dir) => {
      const path = join(dir, "extension.ts");
      writeFileSync(path, "export default () => undefined;", "utf8");
      assert.throws(
        () =>
          resolveExplicitLoadout(
            { extensions: ["untrusted-extension"], tools: [] },
            [{ name: "untrusted-extension", path }],
            [],
          ),
        /trusted registration identity/,
      );
      const resolved = resolveExplicitLoadout(
        { extensions: ["untrusted-extension"], tools: [], identity: "profile-controlled" } as any,
        [{ name: "untrusted-extension", path, identity: "trusted-registration@1" }],
        [],
      );
      assert.equal(resolved.extensions[0].identity, "trusted-registration@1");
    });
  });

  it("pins registered extension identity and entrypoint content for resume", () => {
    withTempDir((dir) => {
      const path = join(dir, "plugin.ts");
      const policyPath = join(dir, "policy.ts");
      writeFileSync(path, "export default () => 1;", "utf8");
      writeFileSync(policyPath, "export const policy = 1;", "utf8");
      const resolved = resolveExplicitLoadout(
        { extensions: ["sample-extension"], tools: ["sample_tool"] },
        [{ name: "sample-extension", path, identity: "sample-extension@1.2.3" }],
        [{ name: "sample_tool", provider: path, contractFingerprint: testContract }],
      );
      assert.equal(resolved.extensions[0].fingerprint?.length, 64);
      const snapshot = {
        version: 1,
        runtimeVersion: "1.4.0",
        extensions: resolved.extensions,
        mcpServers: [],
        toolProviders: resolved.toolProviders,
        runnerFiles: [{ path: policyPath, fingerprint: fingerprintExtension(policyPath) }],
      };
      const registered = [{ name: "sample-extension", path, identity: "sample-extension@1.2.3" }];
      assert.doesNotThrow(() =>
        validateExplicitLoadoutSnapshot(snapshot, {
          runtimeVersion: "1.4.0",
          registeredExtensions: registered,
          requirePinnedContracts: true,
          currentTools: resolved.toolProviders,
        }),
      );
      assert.throws(
        () =>
          validateExplicitLoadoutSnapshot(snapshot, {
            runtimeVersion: "1.4.0",
            registeredExtensions: [{ name: "sample-extension", path, identity: "sample-extension@1.2.4" }],
          }),
        /changed identity/,
      );
      assert.throws(
        () =>
          validateExplicitLoadoutSnapshot(
            {
              ...snapshot,
              extensions: [
                {
                  name: "sample-extension",
                  path,
                  identity: "",
                  fingerprint: resolved.extensions[0].fingerprint,
                },
              ],
            },
            { runtimeVersion: "1.4.0", registeredExtensions: registered },
          ),
        /no trusted registration identity/,
      );
      assert.throws(
        () =>
          validateExplicitLoadoutSnapshot(snapshot, {
            runtimeVersion: "1.4.0",
            registeredExtensions: registered,
            requirePinnedContracts: true,
            currentTools: [{ name: "sample_tool", provider: path, contractFingerprint: "changed" }],
          }),
        /changed provider or contract/,
      );
      assert.throws(
        () =>
          validateExplicitLoadoutSnapshot(snapshot, {
            runtimeVersion: "1.4.0",
            registeredExtensions: registered,
            requirePinnedContracts: true,
            currentTools: [
              { name: "sample_tool", provider: "/extensions/replaced.ts", contractFingerprint: testContract },
            ],
          }),
        /changed provider or contract/,
      );
      writeFileSync(policyPath, "export const policy = 2;", "utf8");
      assert.throws(
        () => validateExplicitLoadoutSnapshot(snapshot, { runtimeVersion: "1.4.0" }),
        /policy code changed/,
      );
      writeFileSync(path, "export default () => 2;", "utf8");
      assert.throws(
        () =>
          validateExplicitLoadoutSnapshot(snapshot, {
            runtimeVersion: "1.4.0",
            registeredExtensions: [{ name: "sample-extension", path, identity: "sample-extension@1.2.3" }],
          }),
        /changed/,
      );
    });
  });

  it("treats an empty extension list as explicit strict mode", () => {
    const resolved = resolveExplicitLoadout(
      { extensions: [], mcpServers: [], tools: ["read"] },
      [],
      [{ name: "read", provider: "builtin:read", contractFingerprint: testContract }],
    );
    assert.equal(resolved.extensions.length, 0);
  });

  it("rejects wildcard grants and duplicate provider identities", () => {
    assert.throws(
      () =>
        resolveExplicitLoadout(
          { extensions: [], mcpServers: [], tools: ["mcp__*"] },
          [],
          [{ name: "mcp__ctx_search", provider: "builtin:mcp" }],
        ),
      /Exact tool names are required/,
    );
    assert.throws(
      () =>
        validateToolProviderGrants(
          [{ name: "read", provider: "builtin:read" }],
          [
            { name: "read", provider: "builtin:read" },
            { name: "read", provider: "builtin:read-shadow" },
          ],
        ),
      /ambiguous/,
    );
  });

  it("authorizes direct and nested calls only for the exact pinned provider", () => {
    const grants = [
      {
        name: "web_search",
        provider: "/extensions/web-search.ts",
        contractFingerprint: testContract,
      },
    ];
    const providers = [
      {
        name: "web_search",
        provider: "/extensions/web-search.ts",
        contractFingerprint: testContract,
      },
    ];
    assert.deepEqual(authorizeToolCall("web_search", grants, providers), { allowed: true });
    assert.match(authorizeToolCall("web_fetch", grants, providers).reason ?? "", /not granted/);
    assert.match(
      authorizeToolCall("web_search", grants, [
        { name: "web_search", provider: "/extensions/other.ts", contractFingerprint: testContract },
      ]).reason ?? "",
      /provider or contract changed/,
    );
    assert.match(
      authorizeToolCall("web_search", grants, [
        {
          name: "web_search",
          provider: "/extensions/web-search.ts",
          contractFingerprint: "changed",
        },
      ]).reason ?? "",
      /provider or contract changed/,
    );
    assert.match(
      authorizeToolCall("web_search", grants, [
        ...providers,
        { name: "web_search", provider: "/extensions/duplicate.ts", contractFingerprint: testContract },
      ]).reason ?? "",
      /provider or contract changed/,
    );
  });

  it("enforces the same exact provider policy for direct and nested tool calls", () => {
    let providers = [{ name: "read", provider: "builtin:read", contractFingerprint: testContract }];
    const policy = createToolPolicyHandlers(
      [{ name: "read", provider: "builtin:read", contractFingerprint: testContract }],
      () => providers,
    );
    assert.equal(policy.authorize({ toolName: "read" })?.block, true);
    policy.start({
      shutdown() {
        assert.fail("valid provider setup should not shut down");
      },
    });
    assert.deepEqual(policy.handleInput(), { action: "continue" });
    assert.equal(policy.authorize({ toolName: "read" })?.block, undefined);
    assert.equal(policy.authorize({ toolName: "write", parentToolCallId: "codemode/1" })?.block, true);
    providers = [{ name: "read", provider: "builtin:read-shadow", contractFingerprint: testContract }];
    assert.equal(policy.authorize({ toolName: "read", parentToolCallId: "codemode/2" })?.block, true);
  });

  it("signals readiness only when the validated initial input is allowed", () => {
    const provider = { name: "read", provider: "builtin:read", contractFingerprint: testContract };
    let readinessSignals = 0;
    const policy = createToolPolicyHandlers(
      [provider],
      () => [provider],
      undefined,
      () => {
        readinessSignals++;
      },
    );
    assert.deepEqual(policy.handleInput(), { action: "handled" });
    policy.start({
      shutdown() {
        assert.fail("valid provider setup should not shut down");
      },
    });
    assert.equal(readinessSignals, 0);
    assert.equal(policy.authorize({ toolName: "read" })?.block, true);
    assert.deepEqual(policy.handleInput(), { action: "continue" });
    assert.equal(readinessSignals, 1);
    assert.equal(policy.authorize({ toolName: "read" })?.block, undefined);

    const invalid = createToolPolicyHandlers([{ ...provider, contractFingerprint: "changed" }], () => [provider]);
    invalid.start({ shutdown() {} });
    assert.deepEqual(invalid.handleInput(), { action: "handled" });

    let currentProviders = [provider];
    let shutdownCount = 0;
    const drifted = createToolPolicyHandlers(
      [provider],
      () => currentProviders,
      undefined,
      () => {
        readinessSignals++;
      },
    );
    drifted.start({
      shutdown() {
        shutdownCount++;
      },
    });
    currentProviders = [{ ...provider, contractFingerprint: "changed" }];
    assert.deepEqual(
      drifted.handleInput({
        shutdown() {
          shutdownCount++;
        },
      }),
      { action: "handled" },
    );
    assert.equal(shutdownCount, 1, "provider drift must shut down the child before the model request");
    assert.equal(readinessSignals, 1, "provider drift must not signal readiness");
  });

  it("defers MCP grant readiness until direct server tools are available", async () => {
    const grant = {
      name: "mcp__selected__read",
      provider: "builtin:mcp",
      mcpServer: "selected",
      contractFingerprint: testContract,
    };
    let providers: (typeof grant)[] = [];
    let readinessSignals = 0;
    const policy = createToolPolicyHandlers(
      [grant],
      () => providers,
      undefined,
      () => readinessSignals++,
    );

    const previousDeadline = process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS;
    process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS = String(Date.now() + 5_000);
    try {
      policy.start({ shutdown: () => assert.fail("MCP tool startup may still be connecting") });
      const pendingInput = policy.handleInput();
      assert.equal(policy.authorize({ toolName: grant.name })?.block, true);

      providers = [grant];
      assert.deepEqual(await pendingInput, { action: "continue" });
      assert.equal(readinessSignals, 1);
      assert.equal(policy.authorize({ toolName: grant.name })?.block, undefined);

      providers = [];
      process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS = String(Date.now() + 1);
      assert.deepEqual(await policy.handleInput(), { action: "handled" });
      assert.equal(policy.authorize({ toolName: grant.name })?.block, true);
    } finally {
      if (previousDeadline === undefined) delete process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS;
      else process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS = previousDeadline;
    }
  });

  it("pins runner-managed tool contracts on the first start and checks them thereafter", () => {
    let pinned: readonly any[] = [];
    let providers = [
      {
        name: "ask_question",
        provider: "/runner/subagent-done.ts",
        contractFingerprint: testContract,
      },
    ];
    const policy = createToolPolicyHandlers(
      [{ name: "ask_question", provider: "/runner/subagent-done.ts", runnerManaged: true }],
      () => providers,
      (grants) => {
        pinned = grants;
      },
    );
    policy.start({
      shutdown() {
        assert.fail("runner tool contract should pin successfully");
      },
    });
    assert.equal((pinned[0] as any).contractFingerprint, testContract);
    assert.deepEqual(policy.handleInput(), { action: "continue" });
    assert.equal(policy.authorize({ toolName: "ask_question" }), undefined);
    providers = [
      {
        name: "ask_question",
        provider: "/runner/subagent-done.ts",
        contractFingerprint: "changed",
      },
    ];
    assert.equal(policy.authorize({ toolName: "ask_question" })?.block, true);
  });

  it("parses explicit resource fields and preserves an empty-list opt-in", () => {
    const parsed = subagentsModule.__test__.parseAgentDefinition(
      ["---", "name: strict-test", "extensions:", "mcp_servers:", "tools: read, codemode", "---", "body"].join("\n"),
      "strict-test",
    );
    assert.ok(parsed);
    assert.equal(parsed.explicitLoadout, true);
    assert.deepEqual(parsed.extensions, []);
    assert.deepEqual(parsed.mcpServers, []);
    assert.equal(parsed.tools, "read, codemode");
  });

  it("normalizes tool descriptions consistently when snapshotting provider contracts", () => {
    const common = { name: "sample_tool", sourceInfo: { path: "builtin:sample" }, parameters: {} };
    const missingDescription = snapshotToolProviders([{ ...common }]);
    const nonStringDescription = snapshotToolProviders([{ ...common, description: 42 }]);
    const emptyDescription = snapshotToolProviders([{ ...common, description: "" }]);
    assert.deepEqual(missingDescription, nonStringDescription);
    assert.deepEqual(nonStringDescription, emptyDescription);
    assert.equal(missingDescription[0].name, "sample_tool");
    assert.equal(missingDescription[0].provider, "builtin:sample");
  });

  it("validates pinned runtime and extension identity before resume", () => {
    const snapshot = {
      version: 1,
      runtimeVersion: "1.4.0",
      extensions: [{ name: "builtin:codemode", path: "builtin:codemode" }],
      mcpServers: [],
      toolProviders: [{ name: "codemode", provider: "builtin:codemode", contractFingerprint: testContract }],
      runnerFiles: [],
    };
    assert.doesNotThrow(() => validateExplicitLoadoutSnapshot(snapshot, { runtimeVersion: "1.4.0" }));
    assert.throws(() => validateExplicitLoadoutSnapshot(snapshot, { runtimeVersion: "1.4.1" }), /runtime changed/);
    const unresolved = {
      ...snapshot,
      toolProviders: [{ name: "ask_question", provider: "/runner", runnerManaged: true }],
    };
    assert.throws(
      () =>
        validateExplicitLoadoutSnapshot(unresolved, {
          runtimeVersion: "1.4.0",
          requirePinnedContracts: true,
        }),
      /not pinned/,
    );
    const pinnedRunnerGrant = {
      ...snapshot,
      toolProviders: [
        {
          name: "ask_question",
          provider: "/runner",
          contractFingerprint: testContract,
          runnerManaged: true,
        },
      ],
    };
    assert.doesNotThrow(() =>
      validateExplicitLoadoutSnapshot(pinnedRunnerGrant, {
        runtimeVersion: "1.4.0",
        requirePinnedContracts: true,
        currentTools: [{ name: "ask_question", provider: "/changed-parent", contractFingerprint: "different" }],
      }),
    );
    assert.throws(
      () =>
        validateExplicitLoadoutSnapshot(
          {
            ...pinnedRunnerGrant,
            toolProviders: [{ name: "selected_tool", provider: "/extension", contractFingerprint: testContract }],
          },
          {
            runtimeVersion: "1.4.0",
            requirePinnedContracts: true,
            currentTools: [{ name: "selected_tool", provider: "/changed-parent", contractFingerprint: "different" }],
          },
        ),
      /changed provider or contract/,
    );
  });

  it("applySandboxToParts explicitly loads codemode and disables MCP in strict mode", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,codemode,ask_question,subagent",
          explicitLoadout: {
            version: 1,
            runtimeVersion: "1.4.0",
            extensions: [{ name: "builtin:codemode", path: "builtin:codemode", identity: "builtin:codemode" }],
            mcpServers: [],
            toolProviders: [
              { name: "read", provider: "builtin:read", contractFingerprint: testContract },
              { name: "codemode", provider: "builtin:codemode", contractFingerprint: testContract },
              { name: "subagent", provider: "/runner/index.ts", runnerManaged: true },
            ],
            runnerFiles: [],
          },
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker", runtimeVersion: "1.4.0", registeredExtensions: [] },
      );
      assert.ok(parts.includes("--no-extensions"));
      assert.ok(parts.includes("--no-mcp"));
      assert.ok(parts.includes("'builtin:codemode'"));
      assert.ok(parts.includes("'/runner/index.ts'"));
      assert.ok(parts.some((part) => part.endsWith("tool-policy.ts'")));
    });
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,safe_bash",
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,safe_bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts passes an explicit thinking level when no model override is present", () => {
    const parts: string[] = [];
    testApi.applySandboxToParts(
      parts,
      {
        agent: "worker",
        toolAllowlist: null,
        model: null,
        thinking: "high",
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: false,
        cwd: null,
        agentDir: null,
      },
      { artifactDir: process.cwd(), name: "worker" },
    );
    assert.deepEqual(parts, ["--thinking", "'high'"]);
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review,lint",
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review",
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        ["name: visible-discovery-test-agent", "description: Visible test agent", "model: anthropic/test-visible"].join(
          "\n",
        ),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(
        () => 3,
        () => {
          assert.equal(runningChildrenCount(), 3);
        },
      );
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(
        () => 0,
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => -1,
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => "two",
        () => assert.equal(runningChildrenCount(), 0),
      );
      withGlobal(
        () => {
          throw new Error("boom");
        },
        () => assert.equal(runningChildrenCount(), 0),
      );
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = {
          shutdown() {
            shutdownCalled = true;
          },
        } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        const askFile = `${sessionFile}.ask`;
        assert.ok(existsSync(askFile), ".ask signal file should be written");
        const payload = JSON.parse(readFileSync(askFile, "utf-8"));
        assert.equal(payload.question, "Which API base URL?");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        // No .exit sidecar — the session is not exiting.
        assert.ok(!existsSync(`${sessionFile}.exit`));
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    function setupCapturingExtension(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) {
          tools.push(t);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        sendUserMessage() {},
        sendMessage() {},
        getAllTools() {
          return [];
        },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) => (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = async () => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, {
          shutdown() {},
        });
      };
      return { emit, ask, restore };
    }

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets awaitingAnswer mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        let shutdown = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown = true;
            },
          },
        );
        assert.equal(shutdown, true, "reply consumed mid-run → agent_end should exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let shutdown = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown = true;
            },
          },
        );
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let shutdown1 = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown1 = true;
            },
          },
        );
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        let shutdown2 = false;
        emit(
          "agent_end",
          { messages: [] },
          {
            shutdown() {
              shutdown2 = true;
            },
          },
        );
        assert.equal(shutdown2, true, "after the reply turn, agent_end should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("tmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("no longer decodes ping payloads (ask_question keeps the session open instead)", () => {
    // ask_question writes a `.ask` signal, not a `.exit` ping sidecar, so an
    // unknown `type: "ping"` payload now falls through to a clean done.
    assert.deepEqual(interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("scrolls the model catalog with a ten-row window and searchable metadata", () => {
    const testApi = (subagentsModule as any).__test__;
    const items = Array.from({ length: 15 }, (_, index) => ({
      value: `provider-${index}/model-${index}`,
      label: `provider-${index}/model-${index}`,
      description: `Friendly ${index} · 32,000 ctx`,
    }));
    items.push({
      value: "__manual_model__",
      label: "Enter provider/model ID manually",
      description: "Use an ID not listed in Pi",
    });
    const actions: Record<string, string> = {
      "tui.select.up": "UP",
      "tui.select.down": "DOWN",
      "tui.select.confirm": "ENTER",
      "tui.select.cancel": "ESC",
    };
    let selected: string | undefined;
    const picker = new testApi.ScrollableModelPicker(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
      { matches: (data: string, action: string) => data === actions[action] },
      items,
      (value: string | undefined) => {
        selected = value;
      },
    );

    let lines = picker.render(120);
    assert.equal(lines[0], "─".repeat(120));
    assert.equal(lines.at(-1), "─".repeat(120));
    let visible = lines.join("\n");
    assert.match(visible, /provider-0\/model-0/);
    assert.match(visible, /Friendly 0 · 32,000 ctx/);
    assert.match(visible, /\(1\/16\)/);
    assert.doesNotMatch(visible, /provider-12\/model-12/);

    for (let i = 0; i < 10; i++) picker.handleInput("DOWN");
    visible = picker.render(120).join("\n");
    assert.match(visible, /provider-10\/model-10/);
    assert.doesNotMatch(visible, /provider-0\/model-0/);
    assert.match(visible, /\(11\/16\)/);
    picker.handleInput("ENTER");
    assert.equal(selected, "provider-10/model-10");

    let preselected: string | undefined;
    const savedModelPicker = new testApi.ScrollableModelPicker(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
      { matches: (data: string, action: string) => data === actions[action] },
      items,
      (value: string | undefined) => {
        preselected = value;
      },
      { initialValue: "provider-10/model-10", title: "Choose a model" },
    );
    savedModelPicker.handleInput("ENTER");
    assert.equal(preselected, "provider-10/model-10");
  });

  it("filters thinking choices by model capabilities and includes all levels for unknown models", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.deepEqual(testApi.thinkingLevelsForModel(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
    assert.deepEqual(testApi.thinkingLevelsForModel({ id: "unknown", reasoning: false }), ["off"]);
    assert.deepEqual(testApi.thinkingLevelsForModel({ id: "gpt-4o", reasoning: true }), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual(testApi.thinkingLevelsForModel({ id: "gpt-5.3", reasoning: true }), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.deepEqual(testApi.thinkingLevelsForModel({ id: "gpt-5.3", reasoning: true }, null), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    const selectedModel = {
      provider: "openai",
      id: "parent",
      name: "Parent",
      contextWindow: 32_000,
    } as any;
    assert.equal(testApi.preferredModelId(undefined, selectedModel), "openai/parent");
    const pickerItems = testApi.modelPickerItems([selectedModel], "custom/provider/model");
    assert.equal(pickerItems[0].value, "custom/provider/model");
    assert.equal(
      testApi.thinkingPickerItems({ id: "gpt-4o", reasoning: true }, "xhigh").initialValue,
      "__pi_default_thinking__",
    );
    assert.equal(testApi.thinkingPickerItems({ id: "gpt-4o", reasoning: true }, "high").initialValue, "high");
  });

  it("saves a Pi-default thinking choice by removing its frontmatter field", () => {
    const testApi = (subagentsModule as any).__test__;
    const content = "---\nname: test-agent\nmodel: openai/old\nthinking: high\ntools: read\n---\nAgent body\n";
    const updated = testApi.updateAgentDefaults(content, "openai/new", null);
    assert.ok(updated);
    assert.match(updated, /model: openai\/new/);
    assert.doesNotMatch(updated, /thinking:/);
    assert.match(updated, /tools: read/);
    assert.match(updated, /Agent body/);
  });

  it("/subagents lets the user choose a model for one spawn", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    assert.ok(command, "expected /subagents to be registered");

    const models = [
      {
        provider: "anthropic",
        id: "claude-test",
        name: "Claude Test",
        contextWindow: 200_000,
        reasoning: true,
      },
    ];
    const commandCtx = {
      cwd: process.cwd(),
      mode: "tui",
      modelRegistry: { getAvailable: () => models },
      ui: {
        custom: chooseFromCustomModelPicker(1),
        select: async (title: string, options: string[]) => {
          if (title === "Choose an agent") return options.find((option) => option === "scout");
          if (title === "Choose an action") return options.find((option) => option === "Spawn once");
          if (title === "Choose a model") {
            assert.ok(
              options.some(
                (option) =>
                  option.includes("Claude Test") &&
                  option.includes("anthropic/claude-test") &&
                  option.includes("200,000 ctx"),
              ),
            );
            return options.find((option) => option.includes("anthropic/claude-test"));
          }
          return undefined;
        },
        input: async () => "inspect model selection",
        notify() {},
      },
    };

    await command.handler("", commandCtx);

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /"agent":"scout"/);
    assert.match(sentUserMessages[0], /"model":"anthropic\/claude-test"/);
    assert.match(sentUserMessages[0], /inspect model selection/);
  });

  it("/subagents preselects saved model and thinking for a one-off spawn", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const dir = createTestDir();
    const agentsDir = join(dir, ".pi", "agents");
    writeAgentFile(agentsDir, "picker-agent", "name: picker-agent\nmodel: openai/saved\nthinking: high");
    const models = [
      { provider: "openai", id: "other", name: "Other", contextWindow: 16_000, reasoning: true },
      { provider: "openai", id: "saved", name: "Saved", contextWindow: 32_000, reasoning: true },
    ];

    try {
      await command.handler("", {
        cwd: dir,
        mode: "tui",
        modelRegistry: { getAvailable: () => models },
        ui: {
          custom: chooseFromCustomModelPicker(),
          select: async (title: string, options: string[]) => {
            if (title === "Choose an agent") return options.find((option) => option === "picker-agent");
            if (title === "Choose an action") return options.find((option) => option === "Spawn once");
            return undefined;
          },
          input: async () => "inspect saved defaults",
          notify() {},
        },
      });

      assert.equal(sentUserMessages.length, 1);
      assert.ok(sentUserMessages[0].includes('"model":"openai/saved"'));
      assert.match(sentUserMessages[0], /"thinking":"high"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/subagents preselects the parent model and Pi default when the agent has no defaults", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const dir = createTestDir();
    const agentsDir = join(dir, ".pi", "agents");
    writeAgentFile(agentsDir, "picker-agent", "name: picker-agent");
    const models = [
      { provider: "openai", id: "other", name: "Other", contextWindow: 16_000, reasoning: true },
      { provider: "openai", id: "parent", name: "Parent", contextWindow: 32_000, reasoning: true },
    ];

    try {
      await command.handler("", {
        cwd: dir,
        mode: "tui",
        model: models[1],
        modelRegistry: { getAvailable: () => models },
        ui: {
          custom: chooseFromCustomModelPicker(),
          select: async (title: string, options: string[]) => {
            if (title === "Choose an agent") return options.find((option) => option === "picker-agent");
            if (title === "Choose an action") return options.find((option) => option === "Spawn once");
            return undefined;
          },
          input: async () => "inspect parent defaults",
          notify() {},
        },
      });

      assert.equal(sentUserMessages.length, 1);
      assert.ok(sentUserMessages[0].includes('"model":"openai/parent"'));
      assert.ok(sentUserMessages[0].includes('"thinking":null'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/subagents accepts an unlisted manual model ID with a warning", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const notices: Array<{ message: string; level: string }> = [];

    await command.handler("", {
      cwd: process.cwd(),
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: chooseFromCustomModelPicker(),
        select: async (title: string, options: string[]) => {
          if (title === "Choose an agent") return options.find((option) => option === "scout");
          if (title === "Choose an action") return options.find((option) => option === "Spawn once");
          if (title === "Choose a model") return options.find((option) => option.includes("manually"));
          return undefined;
        },
        custom: chooseFromCustomModelPicker(1),
        input: async (title: string) => (title === "Enter provider/model ID" ? "custom/provider/model" : "inspect"),
        notify(message: string, level: string) {
          notices.push({ message, level });
        },
      },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /"model":"custom\/provider\/model"/);
    assert.ok(notices.some((notice) => notice.level === "warning"));
  });

  it("/subagents rejects malformed manual model IDs before spawning", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const notices: Array<{ message: string; level: string }> = [];

    await command.handler("", {
      cwd: process.cwd(),
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: chooseFromCustomModelPicker(),
        select: async (title: string, options: string[]) => {
          if (title === "Choose an agent") return options.find((option) => option === "scout");
          if (title === "Choose an action") return options.find((option) => option === "Spawn once");
          if (title === "Choose a model") return options.find((option) => option.includes("manually"));
          return undefined;
        },
        custom: chooseFromCustomModelPicker(1),
        input: async (title: string) => (title === "Enter provider/model ID" ? "missing-provider" : undefined),
        notify(message: string, level: string) {
          notices.push({ message, level });
        },
      },
    });

    assert.equal(sentUserMessages.length, 0);
    assert.ok(notices.some((notice) => notice.level === "error"));
  });

  it("/subagents explains when a global default is shadowed by a project agent", async () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const dir = createTestDir();
    const agentsDir = join(dir, ".pi", "agents");
    writeAgentFile(agentsDir, "project-agent", "name: project-agent\nmodel: openai/old");
    const selections: Array<{ title: string; options: string[] }> = [];

    try {
      await command.handler("", {
        cwd: dir,
        mode: "tui",
        modelRegistry: {
          getAvailable: () => [{ provider: "openai", id: "new", name: "New", contextWindow: 16_000, reasoning: true }],
        },
        ui: {
          custom: chooseFromCustomModelPicker(1),
          select: async (title: string, options: string[]) => {
            selections.push({ title, options });
            if (title === "Choose an agent") return options.find((option) => option === "project-agent");
            if (title === "Choose an action") return options.find((option) => option === "Change default");
            if (title === "Choose a model") return options.find((option) => option.includes("openai/new"));
            if (title === "Save this default where?") return options.find((option) => option === "Global");
            if (title.startsWith("A project-local definition")) return options.find((option) => option === "Cancel");
            return undefined;
          },
          input: async () => undefined,
          notify() {},
        },
      });

      const conflict = selections.find((selection) => selection.title.startsWith("A project-local definition"));
      assert.deepEqual(conflict?.options, [
        "Save globally anyway (won't affect this project)",
        "Switch to project-local",
        "Cancel",
      ]);
      assert.doesNotMatch(readFileSync(join(agentsDir, "project-agent.md"), "utf8"), /model: openai\/new/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/subagents saves a project default without losing the agent profile", async () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const dir = createTestDir();
    const projectAgents = join(dir, ".pi", "agents");
    writeAgentFile(
      projectAgents,
      "local-agent",
      "name: local-agent\nmodel: openai/model-test\nthinking: low\ntools: read, write\nsystem-prompt: append",
    );
    const model = {
      provider: "openai",
      id: "model-test",
      name: "Test Model",
      contextWindow: 32_000,
      reasoning: true,
    };

    try {
      await command.handler("", {
        cwd: dir,
        mode: "tui",
        modelRegistry: { getAvailable: () => [model] },
        ui: {
          custom: chooseFromCustomModelPicker([0, 1]),
          select: async (title: string, options: string[]) => {
            if (title === "Choose an agent") return options.find((option) => option === "local-agent");
            if (title === "Choose an action") return options.find((option) => option === "Change default");
            if (title === "Choose a model") return options.find((option) => option.includes("openai/model-test"));
            if (title === "Save this default where?") return options.find((option) => option === "Project-local");
            return undefined;
          },
          input: async () => undefined,
          notify() {},
        },
      });

      const saved = readFileSync(join(projectAgents, "local-agent.md"), "utf8");
      assert.match(saved, /model: openai\/model-test/);
      assert.match(saved, /thinking: medium/);
      assert.match(saved, /tools: read, write/);
      assert.match(saved, /system-prompt: append/);
      assert.match(saved, /You are a test agent\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/subagents removes a saved thinking field when Pi default is saved", async () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    const dir = createTestDir();
    const projectAgents = join(dir, ".pi", "agents");
    writeAgentFile(projectAgents, "local-agent", "name: local-agent\nmodel: openai/model-test\nthinking: high");
    const model = {
      provider: "openai",
      id: "model-test",
      name: "Test Model",
      contextWindow: 32_000,
      reasoning: true,
    };

    try {
      await command.handler("", {
        cwd: dir,
        mode: "tui",
        modelRegistry: { getAvailable: () => [model] },
        ui: {
          custom: chooseFromCustomModelPicker([0, 1]),
          select: async (title: string, options: string[]) => {
            if (title === "Choose an agent") return options.find((option) => option === "local-agent");
            if (title === "Choose an action") return options.find((option) => option === "Change default");
            if (title === "Save this default where?") return options.find((option) => option === "Project-local");
            return undefined;
          },
          input: async () => undefined,
          notify() {},
        },
      });

      const saved = readFileSync(join(projectAgents, "local-agent.md"), "utf8");
      assert.ok(saved.includes("model: openai/model-test"));
      assert.doesNotMatch(saved, /^thinking:/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/subagents cancellation before selection has no side effects", async () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((entry) => entry.name === "subagents");
    assert.ok(command, "expected /subagents to be registered");

    await command.handler("", {
      cwd: process.cwd(),
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: { select: async () => undefined, input: async () => undefined, notify() {} },
    });

    assert.equal(sentUserMessages.length, 0);
  });

  it("subagents_list shows configured defaults and the Pi fallback", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagents_list");
    const dir = createTestDir();
    const projectAgents = join(dir, ".pi", "agents");
    writeAgentFile(projectAgents, "with-model", "name: with-model\nmodel: openai/model-x");
    writeAgentFile(projectAgents, "without-model", "name: without-model");

    try {
      const result = await tool.execute("call", {}, undefined, undefined, { cwd: dir });
      assert.match(result.content[0].text, /with-model \(project\) \[openai\/model-x\]/);
      assert.match(result.content[0].text, /without-model \(project\) \[Pi default\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(
      registeredCommands.find((c) => c.name === "iterate"),
      undefined,
    );
    assert.equal(
      registeredCommands.find((c) => c.name === "plan"),
      undefined,
    );
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });

  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema with an optional model and thinking override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task", "thinking"],
      "only agent/task/name/model/cwd/thinking should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // `name` is now optional and purely cosmetic.
    assert.match(props.name.description, /cosmetic/i);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("no longer registers subagent_interrupt or subagent_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and not the old interrupt/resume tools", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime: 1_000_000 - 13_000,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
          },
          {
            id: "a2",
            name: "B",
            task: "",
            surface: "s2",
            startTime: 1_000_000 - 21_000,
            sessionFile: "sess2",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
          },
          {
            id: "a3",
            name: "C",
            task: "",
            surface: "s3",
            startTime: 1_000_000 - 27_000,
            sessionFile: "sess3",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
          },
        ],
        16,
      );

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("shows the model and its source in active-subagent status", () => {
    const testApi = (subagentsModule as any).__test__;
    const startTime = Date.now();
    const lines = testApi.renderSubagentWidgetLines(
      [
        {
          id: "model-agent",
          name: "scout",
          task: "",
          agent: "scout",
          model: "anthropic/claude-test",
          modelSource: "spawn override",
          surface: "s1",
          startTime,
          sessionFile: "missing-session",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ],
      100,
    );

    assert.match(lines[1], /anthropic\/claude-test/);
    assert.match(lines[1], /spawn override/);
  });

  it("shows the model reported by a running session when available", () => {
    const testApi = (subagentsModule as any).__test__;
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [
        SESSION_HEADER,
        {
          type: "message",
          id: "assistant-active",
          parentId: null,
          message: {
            role: "assistant",
            model: "openai/runtime-model",
            content: [{ type: "text", text: "working" }],
          },
        },
      ]);
      const startTime = Date.now();
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "model-agent",
            name: "scout",
            task: "",
            agent: "scout",
            model: null,
            modelSource: "Pi default",
            surface: "s1",
            startTime,
            sessionFile,
            statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
          },
        ],
        100,
      );

      assert.match(lines[1], /openai\/runtime-model \(Pi default\)/);
    });
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
          },
        ],
        width,
      );

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("tmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});
