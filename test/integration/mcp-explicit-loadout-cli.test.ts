import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createExplicitLoadoutSnapshot,
  resolveExplicitLoadout,
  snapshotToolProviders,
} from "../../pi-extension/subagents/loadout.ts";
import { resolveMcpServerIdentities } from "../../pi-extension/subagents/mcp-identity.ts";
import { buildStartupDeadlineCommand } from "../../pi-extension/subagents/startup.ts";
import { shellEscape } from "../../pi-extension/subagents/tmux.ts";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOOL_POLICY = join(PROJECT_ROOT, "pi-extension/subagents/tool-policy.ts");
const LOADOUT_MODULE = join(PROJECT_ROOT, "pi-extension/subagents/loadout.ts");
const MCP_IDENTITY_MODULE = join(PROJECT_ROOT, "pi-extension/subagents/mcp-identity.ts");

function getCodemodeEntryPoint(version: string): string | undefined {
  const agentDirs = [...new Set([process.env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent")].filter(Boolean))];
  const packageRoots = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];
  for (const agentDir of agentDirs) {
    for (const packageRoot of packageRoots) {
      const path = join(
        agentDir as string,
        "install",
        "releases",
        version,
        "node_modules",
        packageRoot,
        "dist",
        "extensions",
        "codemode",
        "index.js",
      );
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

type ScenarioCall = { id: string; name: string; arguments: Record<string, unknown> };

function runShell(command: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn("bash", ["-c", command], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

describe("explicit MCP grants in the real Pi CLI", () => {
  it("enforces direct and codemode grants across configured servers and rejects MCP config drift on resume", {
    timeout: 60_000,
  }, async (context) => {
    const versionResult = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(versionResult.status, 0, versionResult.stderr);
    const runtimeVersion = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    const codemodePath = runtimeVersion ? getCodemodeEntryPoint(runtimeVersion) : undefined;
    if (!codemodePath) {
      context.skip("The installed Pi CLI codemode entrypoint is unavailable for an isolated MCP config.");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-loadout-cli-"));
    const agentDir = join(dir, "agent-config");
    mkdirSync(agentDir, { recursive: true });

    const requests: Record<string, any>[] = [];
    let scenarioCalls: ScenarioCall[] = [];
    const modelServer = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.includes("chat/completions")) {
        request.resume();
        response.writeHead(404);
        response.end();
        return;
      }
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push(JSON.parse(body));
        const chunk = (delta: object, finishReason: string | null = null) => ({
          id: "chatcmpl-mcp-grant-probe",
          object: "chat.completion.chunk",
          created: 1,
          model: "probe",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\r\n\r\n`);
        const call = scenarioCalls[requests.length - 1];
        if (call) {
          response.write(
            `data: ${JSON.stringify(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              }),
            )}\r\n\r\n`,
          );
          response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\r\n\r\n`);
        } else {
          response.write(`data: ${JSON.stringify(chunk({ content: "MCP_POLICY_OK" }))}\r\n\r\n`);
          response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\r\n\r\n`);
        }
        response.end("data: [DONE]\r\n\r\n");
      });
    });

    try {
      await new Promise<void>((resolvePromise, reject) => {
        modelServer.once("error", reject);
        modelServer.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = modelServer.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "fixture-only",
              models: [
                {
                  id: "probe",
                  name: "Probe",
                  contextWindow: 4096,
                  maxTokens: 128,
                  input: ["text"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
      );

      const mcpServerPath = join(dir, "mcp-server.mjs");
      const selectedCallsPath = join(dir, "selected-calls.txt");
      const otherCallsPath = join(dir, "other-calls.txt");
      writeFileSync(
        mcpServerPath,
        `import { appendFileSync } from "node:fs";\n` +
          `import readline from "node:readline";\n` +
          `const [server, callsPath] = process.argv.slice(2);\n` +
          `const toolNames = server === "selected" ? ["granted", "ungranted"] : ["other"];\n` +
          `const tools = toolNames.map((name) => ({ name, description: "Record the provided value.", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }));\n` +
          `const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");\n` +
          `readline.createInterface({ input: process.stdin }).on("line", (line) => {\n` +
          `  const message = JSON.parse(line);\n` +
          `  if (message.method === "initialize") send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } });\n` +
          `  else if (message.method === "tools/list") send(message.id, { tools });\n` +
          `  else if (message.method === "tools/call") { appendFileSync(callsPath, message.params.name + "\\n"); send(message.id, { content: [{ type: "text", text: server + ":" + message.params.name + ":" + message.params.arguments.value }] }); }\n` +
          `  else if (message.id !== undefined) send(message.id, {});\n` +
          `});\n`,
        "utf8",
      );
      writeFileSync(
        join(agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            selected: {
              command: process.execPath,
              args: [mcpServerPath, "selected", selectedCallsPath],
              exposure: "direct",
            },
            other: { command: process.execPath, args: [mcpServerPath, "other", otherCallsPath], exposure: "direct" },
          },
        }),
      );

      const metadataPath = join(dir, "tool-metadata.json");
      const probePath = join(dir, "mcp-provider-probe.ts");
      writeFileSync(
        probePath,
        `import { writeFileSync } from "node:fs";\n` +
          `import { snapshotToolProviders } from ${JSON.stringify(LOADOUT_MODULE)};\n` +
          `export default function(pi: any) { pi.on("before_agent_start", async (_event: unknown, ctx: any) => {\n` +
          `  const names = ["codemode", "mcp__selected__granted", "mcp__selected__ungranted", "mcp__other__other"];\n` +
          `  const deadline = Date.now() + 10_000;\n` +
          `  let tools: any[] = [];\n` +
          `  while (Date.now() < deadline) { tools = pi.getAllTools().filter((tool: any) => names.includes(tool.name)); if (tools.length === names.length) break; await new Promise((resolve) => setTimeout(resolve, 25)); }\n` +
          `  if (tools.length !== names.length) throw new Error("MCP fixture tools did not become available.");\n` +
          `  writeFileSync(${JSON.stringify(metadataPath)}, JSON.stringify(snapshotToolProviders(tools)));\n` +
          `  ctx.shutdown();\n` +
          `}); }\n`,
        "utf8",
      );
      const probe = await runShell(
        [
          "exec pi --no-session --no-extensions",
          `--tools ${shellEscape("codemode,mcp__selected__granted,mcp__selected__ungranted,mcp__other__other")}`,
          `-e ${shellEscape("builtin:mcp")}`,
          `-e ${shellEscape(codemodePath)}`,
          `-e ${shellEscape(probePath)}`,
          "--model openai/probe --print",
          shellEscape("probe MCP providers"),
        ].join(" "),
        { PI_CODING_AGENT_DIR: agentDir },
        15_000,
      );
      assert.equal(probe.status, 0, `MCP metadata probe failed:\n${probe.stdout}\n${probe.stderr}`);
      assert.ok(existsSync(metadataPath), `MCP provider metadata was not captured:\n${probe.stderr}`);
      const availableTools = JSON.parse(readFileSync(metadataPath, "utf8"));
      assert.deepEqual(
        availableTools
          .filter((tool: any) => tool.provider === "builtin:mcp")
          .map((tool: any) => [tool.name, tool.mcpServer])
          .sort(),
        [
          ["mcp__other__other", "other"],
          ["mcp__selected__granted", "selected"],
          ["mcp__selected__ungranted", "selected"],
        ],
      );
      assert.ok(availableTools.some((tool: any) => tool.name === "codemode" && tool.provider === codemodePath));

      const serverIdentities = resolveMcpServerIdentities(["selected"], {
        agentDir,
        cwd: process.cwd(),
      });
      const resolved = resolveExplicitLoadout(
        { extensions: ["codemode"], mcpServers: ["selected"], tools: ["codemode", "mcp__selected__granted"] },
        [{ name: "codemode", path: codemodePath, identity: `codemode@${runtimeVersion}` }],
        availableTools,
        serverIdentities,
      );
      const policyPath = join(dir, "loadout.json");
      const policy = createExplicitLoadoutSnapshot(
        resolved,
        runtimeVersion as string,
        [],
        [TOOL_POLICY, LOADOUT_MODULE, MCP_IDENTITY_MODULE, codemodePath],
      );
      writeFileSync(policyPath, JSON.stringify({ explicitLoadout: policy }), { mode: 0o600 });
      assert.doesNotMatch(readFileSync(policyPath, "utf8"), /fixture-only|first-secret|second-secret/);

      requests.length = 0;
      scenarioCalls = [
        { id: "mcp-granted", name: "mcp__selected__granted", arguments: { value: "allowed" } },
        { id: "mcp-selected-denied", name: "mcp__selected__ungranted", arguments: { value: "denied" } },
        { id: "mcp-other-denied", name: "mcp__other__other", arguments: { value: "denied" } },
      ];
      const readyPath = join(dir, "ready");
      const sessionPath = join(dir, "session.jsonl");
      const command = [
        "exec pi --session",
        shellEscape(sessionPath),
        "--no-extensions",
        `--tools ${shellEscape("codemode,mcp__selected__granted,mcp__selected__ungranted,mcp__other__other")}`,
        `-e ${shellEscape("builtin:mcp")}`,
        `-e ${shellEscape(codemodePath)}`,
        `-e ${shellEscape(TOOL_POLICY)}`,
        "--model openai/probe --print",
        shellEscape("Try the granted direct MCP tool and then two ungranted tools."),
      ].join(" ");
      const result = await runShell(
        buildStartupDeadlineCommand({
          command,
          readyFile: readyPath,
          exitFile: `${sessionPath}.exit`,
          timeoutMs: 20_000,
          escape: shellEscape,
        }),
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_SUBAGENT_LOADOUT_FILE: policyPath,
          PI_SUBAGENT_SESSION: sessionPath,
          PI_SUBAGENT_READY_FILE: readyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 20_000),
        },
        25_000,
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /MCP_POLICY_OK/);
      assert.equal(readFileSync(selectedCallsPath, "utf8"), "granted\n");
      assert.equal(existsSync(otherCallsPath), false, "ungranted tools from either MCP server must not execute");
      assert.match(JSON.stringify(requests[2]?.messages), /not granted/i);
      assert.match(JSON.stringify(requests[3]?.messages), /not granted/i);
      assert.equal(readFileSync(readyPath, "utf8"), "ready");

      requests.length = 0;
      scenarioCalls = [
        {
          id: "mcp-nested-granted",
          name: "codemode",
          arguments: {
            code: 'const result = await tools["mcp__selected__granted"]({ value: "nested" }); text(result);',
          },
        },
        {
          id: "mcp-nested-selected-denied",
          name: "codemode",
          arguments: {
            code: 'await searchTools("mcp__selected__ungranted"); await tools["mcp__selected__ungranted"]({ value: "denied" });',
          },
        },
        {
          id: "mcp-nested-other-denied",
          name: "codemode",
          arguments: {
            code: 'await tools["mcp__other__other"]({ value: "denied" });',
          },
        },
      ];
      const nestedSessionPath = join(dir, "nested-session.jsonl");
      const nestedReadyPath = join(dir, "nested-ready");
      const nestedCommand = command
        .replace(shellEscape(sessionPath), shellEscape(nestedSessionPath))
        .replace(
          shellEscape("Try the granted direct MCP tool and then two ungranted tools."),
          shellEscape("Use codemode for MCP calls."),
        );
      const nestedResult = await runShell(
        buildStartupDeadlineCommand({
          command: nestedCommand,
          readyFile: nestedReadyPath,
          exitFile: `${nestedSessionPath}.exit`,
          timeoutMs: 20_000,
          escape: shellEscape,
        }),
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_SUBAGENT_LOADOUT_FILE: policyPath,
          PI_SUBAGENT_SESSION: nestedSessionPath,
          PI_SUBAGENT_READY_FILE: nestedReadyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 20_000),
        },
        25_000,
      );
      assert.equal(nestedResult.status, 0, `${nestedResult.stdout}\n${nestedResult.stderr}`);
      assert.match(nestedResult.stdout, /MCP_POLICY_OK/);
      assert.match(JSON.stringify(requests[1]?.messages), /selected:granted:nested/);
      assert.match(JSON.stringify(requests[2]?.messages), /not granted/i);
      assert.match(JSON.stringify(requests[3]?.messages), /not granted/i);
      assert.equal(readFileSync(selectedCallsPath, "utf8"), "granted\ngranted\n");
      assert.equal(existsSync(otherCallsPath), false, "codemode must not call ungranted MCP tools from either server");

      // A changed tool contract must fail closed when reopening the saved child session.
      const mcpServerSource = readFileSync(mcpServerPath, "utf8");
      writeFileSync(mcpServerPath, mcpServerSource.replace("Record the provided value.", "Changed tool contract."));
      requests.length = 0;
      scenarioCalls = [];
      const changedToolResume = await runShell(
        [
          "exec pi",
          "--session",
          shellEscape(nestedSessionPath),
          "--no-extensions",
          `--tools ${shellEscape("codemode,mcp__selected__granted,mcp__selected__ungranted,mcp__other__other")}`,
          `-e ${shellEscape("builtin:mcp")}`,
          `-e ${shellEscape(codemodePath)}`,
          `-e ${shellEscape(TOOL_POLICY)}`,
          "--model openai/probe --print",
          shellEscape("Resume and try another MCP call."),
        ].join(" "),
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_SUBAGENT_LOADOUT_FILE: policyPath,
          PI_SUBAGENT_SESSION: nestedSessionPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 20_000),
        },
        10_000,
      );
      assert.equal(changedToolResume.status, 0, `${changedToolResume.stdout}\n${changedToolResume.stderr}`);
      assert.match(changedToolResume.stderr, /changed provider or contract/);
      assert.equal(
        requests.length,
        0,
        `changed MCP tool contract must be rejected before model use: ${changedToolResume.stdout} ${changedToolResume.stderr}`,
      );
      assert.equal(readFileSync(selectedCallsPath, "utf8"), "granted\ngranted\n", "resume must not call tools");

      // Reopening the saved child session after a safe, non-secret MCP config change must fail
      // during policy startup, before another model request or MCP tool call can happen.
      const mcpConfigPath = join(agentDir, "mcp.json");
      const changedConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      changedConfig.mcpServers.selected.description = "Changed fixture description.";
      writeFileSync(mcpConfigPath, JSON.stringify(changedConfig));
      requests.length = 0;
      scenarioCalls = [];
      const resumeResult = await runShell(
        [
          "exec pi",
          "--session",
          shellEscape(nestedSessionPath),
          "--no-extensions",
          `--tools ${shellEscape("codemode,mcp__selected__granted,mcp__selected__ungranted,mcp__other__other")}`,
          `-e ${shellEscape("builtin:mcp")}`,
          `-e ${shellEscape(codemodePath)}`,
          `-e ${shellEscape(TOOL_POLICY)}`,
          "--model openai/probe --print",
          shellEscape("Resume and try another MCP call."),
        ].join(" "),
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_SUBAGENT_LOADOUT_FILE: policyPath,
          PI_SUBAGENT_SESSION: nestedSessionPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 20_000),
        },
        10_000,
      );
      assert.equal(resumeResult.status, 0, `${resumeResult.stdout}\n${resumeResult.stderr}`);
      assert.match(resumeResult.stderr, /changed configuration identity/);
      assert.equal(requests.length, 0, "changed MCP configuration must be rejected before model use");
      assert.equal(readFileSync(selectedCallsPath, "utf8"), "granted\ngranted\n", "resume must not call tools");
    } finally {
      await new Promise<void>((resolvePromise) => modelServer.close(() => resolvePromise()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
