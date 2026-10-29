import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStartupDeadlineCommand } from "../../pi-extension/subagents/startup.ts";
import { shellEscape } from "../../pi-extension/subagents/tmux.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOOL_POLICY = join(PROJECT_ROOT, "pi-extension/subagents/tool-policy.ts");
const SUBAGENT_DONE = join(PROJECT_ROOT, "pi-extension/subagents/subagent-done.ts");
const SUBAGENTS_EXTENSION = join(PROJECT_ROOT, "pi-extension/subagents/index.ts");
const LOADOUT_MODULE = join(PROJECT_ROOT, "pi-extension/subagents/loadout.ts");
const PI_TIMEOUT = 20_000;

function runPi(args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync("pi", args, {
    encoding: "utf8",
    timeout: PI_TIMEOUT,
    env: { ...process.env, PI_OFFLINE: "1", ...extraEnv },
  });
  if (result.error) throw result.error;
  return result;
}

function runShell(command: string, extraEnv: Record<string, string>, timeoutMs: number) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    delete env.PI_OFFLINE;
    const child = spawn("bash", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

describe("explicit loadout Pi CLI smoke", () => {
  it("loads only codemode and validates actual provider contracts before session use", {
    timeout: 45_000,
  }, () => {
    const versionResult = runPi(["--version"]);
    if (versionResult.status !== 0) {
      assert.fail(`Could not query Pi CLI version: ${versionResult.stderr}`);
    }
    const version = versionResult.stdout.trim();
    const majorMinor = version.match(/^(\d+)\.(\d+)/);
    if (!majorMinor || Number(majorMinor[1]) < 1 || (Number(majorMinor[1]) === 1 && Number(majorMinor[2]) < 4)) {
      return; // Strict loadouts require the verified Pi 1.4 tool metadata API.
    }

    const dir = mkdtempSync(join(tmpdir(), "pi-explicit-loadout-cli-"));
    const policyPath = join(dir, "loadout.json");
    const startupMarker = join(dir, "policy-started");
    const readyPath = join(dir, "loadout-ready");
    const probePath = join(dir, "provider-probe.ts");
    const markerPath = join(dir, "startup-marker.ts");
    try {
      writeFileSync(
        probePath,
        `import { writeFileSync } from "node:fs";\n` +
          `import { fingerprintToolContract } from ${JSON.stringify(LOADOUT_MODULE)};\n` +
          `export default function(pi: any) {\n` +
          `  pi.on("session_start", (_event: unknown, ctx: any) => {\n` +
          `    const selected = pi.getAllTools().filter((tool: any) => ["read", "codemode"].includes(tool.name));\n` +
          `    if (selected.length !== 2) throw new Error("Expected read and codemode in the Pi tool registry.");\n` +
          `    const toolProviders = selected.map((tool: any) => ({ name: tool.name, provider: tool.sourceInfo?.path, contractFingerprint: fingerprintToolContract({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters }) }));\n` +
          `    writeFileSync(${JSON.stringify(policyPath)}, JSON.stringify({ explicitLoadout: { version: 1, toolProviders } }), { mode: 0o600 });\n` +
          `    ctx.shutdown();\n` +
          `  });\n` +
          `}\n`,
        "utf8",
      );
      const probe = runPi([
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--tools",
        "read,codemode",
        "-e",
        "builtin:codemode",
        "-e",
        probePath,
        "--print",
        "smoke",
      ]);
      assert.equal(probe.status, 0, `Tool metadata probe failed:\n${probe.stdout}\n${probe.stderr}`);
      const snapshot = JSON.parse(readFileSync(policyPath, "utf8"));
      assert.deepEqual(snapshot.explicitLoadout.toolProviders.map((tool: any) => [tool.name, tool.provider]).sort(), [
        ["codemode", "builtin:codemode"],
        ["read", "builtin:read"],
      ]);

      writeFileSync(
        markerPath,
        `import { writeFileSync } from "node:fs";\n` +
          `export default function(pi: any) { pi.on("session_start", (_event: unknown, ctx: any) => { writeFileSync(${JSON.stringify(startupMarker)}, "started"); ctx.shutdown(); }); }\n`,
        "utf8",
      );
      const policyRun = runPi(
        [
          "--no-session",
          "--no-extensions",
          "--no-mcp",
          "--tools",
          "read,codemode",
          "-e",
          "builtin:codemode",
          "-e",
          TOOL_POLICY,
          "-e",
          markerPath,
          "--print",
          "smoke",
        ],
        {
          PI_SUBAGENT_LOADOUT_FILE: policyPath,
          PI_SUBAGENT_READY_FILE: readyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 45_000),
        },
      );
      assert.equal(policyRun.status, 0, `Strict policy startup failed:\n${policyRun.stdout}\n${policyRun.stderr}`);
      assert.doesNotMatch(policyRun.stderr, /Explicit subagent loadout rejected/);
      assert.equal(readFileSync(startupMarker, "utf8"), "started");
      assert.equal(readFileSync(readyPath, "utf8"), "validated");

      // Also load the package's real extension entrypoint under this runtime to
      // verify the package/API namespace combination without invoking a model.
      const extensionMarker = join(dir, "extension-started");
      writeFileSync(
        markerPath,
        `import { writeFileSync } from "node:fs";\n` +
          `export default function(pi: any) { pi.on("session_start", (_event: unknown, ctx: any) => { writeFileSync(${JSON.stringify(extensionMarker)}, "started"); ctx.shutdown(); }); }\n`,
        "utf8",
      );
      const extensionRun = runPi([
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "-e",
        SUBAGENTS_EXTENSION,
        "-e",
        markerPath,
        "--print",
        "smoke",
      ]);
      assert.equal(
        extensionRun.status,
        0,
        `Package extension failed to load:\n${extensionRun.stdout}\n${extensionRun.stderr}`,
      );
      assert.equal(readFileSync(extensionMarker, "utf8"), "started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires provider readiness before the first model request and bounds startup", {
    timeout: 30_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loadout-readiness-"));
    const requests: string[] = [];
    const modelRequestCount = () =>
      requests.filter((request) => request.startsWith("POST ") && request.includes("chat/completions")).length;
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      request.resume();
      request.on("end", () => {
        const chunk = (delta: object, finishReason: string | null = null) => ({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1,
          model: "probe",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\r\n\r\n`);
        response.write(`data: ${JSON.stringify(chunk({ content: "PROBE_OK" }))}\r\n\r\n`);
        response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\r\n\r\n`);
        response.end("data: [DONE]\r\n\r\n");
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const configDir = join(dir, "agent-config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "test-only",
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

      const policyPath = join(dir, "loadout.json");
      writeFileSync(policyPath, JSON.stringify({ explicitLoadout: { version: 1, toolProviders: [] } }));
      const readyPath = join(dir, "ready");
      const sessionPath = join(dir, "session.jsonl");
      const exitPath = `${sessionPath}.exit`;
      const cli = [
        "exec pi --no-session --no-extensions --tools read",
        `-e ${shellEscape(SUBAGENT_DONE)} -e ${shellEscape(TOOL_POLICY)}`,
        "--model openai/probe --print",
        shellEscape("Say only PROBE_OK"),
      ].join(" ");
      const env = {
        PI_CODING_AGENT_DIR: configDir,
        PI_SUBAGENT_LOADOUT_FILE: policyPath,
        PI_SUBAGENT_SESSION: sessionPath,
        PI_SUBAGENT_READY_FILE: readyPath,
        PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 5000),
      };
      const successfulRun = await runShell(
        buildStartupDeadlineCommand({
          command: cli,
          readyFile: readyPath,
          exitFile: exitPath,
          timeoutMs: 5000,
          escape: shellEscape,
        }),
        env,
        12_000,
      );
      assert.equal(successfulRun.status, 0, successfulRun.stderr);
      assert.match(successfulRun.stdout, /PROBE_OK/, successfulRun.stderr);
      assert.equal(readFileSync(readyPath, "utf8"), "ready");
      assert.ok(
        modelRequestCount() > 0,
        `the ready child should reach the local model endpoint: ${requests.join(", ")}`,
      );
      const requestsAfterSuccessfulRun = modelRequestCount();

      writeFileSync(
        policyPath,
        JSON.stringify({
          explicitLoadout: {
            version: 1,
            toolProviders: [{ name: "read", provider: "builtin:read", contractFingerprint: "changed-contract" }],
          },
        }),
      );
      const rejectedReadyPath = join(dir, "rejected.ready");
      const rejectedSessionPath = join(dir, "rejected.jsonl");
      const rejectedExitPath = `${rejectedSessionPath}.exit`;
      const rejectedRun = await runShell(
        buildStartupDeadlineCommand({
          command: cli,
          readyFile: rejectedReadyPath,
          exitFile: rejectedExitPath,
          timeoutMs: 5000,
          escape: shellEscape,
        }),
        {
          ...env,
          PI_SUBAGENT_SESSION: rejectedSessionPath,
          PI_SUBAGENT_READY_FILE: rejectedReadyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 5000),
        },
        12_000,
      );
      assert.equal(rejectedRun.status, 0, rejectedRun.stderr);
      assert.equal(existsSync(rejectedReadyPath), false);
      assert.match(rejectedRun.stderr, /Explicit subagent loadout rejected before tool use/);
      assert.equal(
        modelRequestCount(),
        requestsAfterSuccessfulRun,
        `a changed provider contract must not reach the model endpoint: ${requests.join(", ")}`,
      );
      assert.match(readFileSync(rejectedExitPath, "utf8"), /rejected before model use/);

      const missingPolicyReadyPath = join(dir, "missing-policy.ready");
      const missingPolicySessionPath = join(dir, "missing-policy.jsonl");
      const missingPolicyCommand = [
        "exec pi --no-session --no-extensions --tools read",
        `-e ${shellEscape(SUBAGENT_DONE)}`,
        "--model openai/probe --print",
        shellEscape("Say only PROBE_OK"),
      ].join(" ");
      const missingPolicyRun = await runShell(
        buildStartupDeadlineCommand({
          command: missingPolicyCommand,
          readyFile: missingPolicyReadyPath,
          exitFile: `${missingPolicySessionPath}.exit`,
          timeoutMs: 5000,
          escape: shellEscape,
        }),
        {
          ...env,
          PI_SUBAGENT_SESSION: missingPolicySessionPath,
          PI_SUBAGENT_READY_FILE: missingPolicyReadyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 5000),
        },
        12_000,
      );
      assert.equal(missingPolicyRun.status, 0, missingPolicyRun.stderr);
      assert.equal(existsSync(missingPolicyReadyPath), false, "a missing policy cannot signal readiness");
      assert.equal(
        modelRequestCount(),
        requestsAfterSuccessfulRun,
        "a missing policy extension must not reach the model endpoint",
      );

      writeFileSync(policyPath, JSON.stringify({ explicitLoadout: { version: 1, toolProviders: [] } }));
      const hangingExtensionPath = join(dir, "hanging-extension.ts");
      writeFileSync(
        hangingExtensionPath,
        "export default async function() { await new Promise(() => setInterval(() => {}, 1000)); }\n",
      );
      const hangingCommand = [
        "exec pi --no-session --no-extensions --tools read",
        `-e ${shellEscape(SUBAGENT_DONE)}`,
        `-e ${shellEscape(hangingExtensionPath)}`,
        `-e ${shellEscape(TOOL_POLICY)}`,
        "--model openai/probe --print",
        shellEscape("Say only PROBE_OK"),
      ].join(" ");
      const timedOutReadyPath = join(dir, "timed-out.ready");
      const timedOutSessionPath = join(dir, "timed-out.jsonl");
      const timedOutExitPath = `${timedOutSessionPath}.exit`;
      const timedOutRun = await runShell(
        buildStartupDeadlineCommand({
          command: hangingCommand,
          readyFile: timedOutReadyPath,
          exitFile: timedOutExitPath,
          timeoutMs: 250,
          escape: shellEscape,
        }),
        {
          ...env,
          PI_SUBAGENT_SESSION: timedOutSessionPath,
          PI_SUBAGENT_READY_FILE: timedOutReadyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 250),
        },
        8000,
      );
      assert.equal(timedOutRun.status, 0, timedOutRun.stderr);
      assert.equal(existsSync(timedOutReadyPath), false);
      assert.equal(
        modelRequestCount(),
        requestsAfterSuccessfulRun,
        "a child that never becomes ready must not call the model",
      );
      assert.match(readFileSync(timedOutExitPath, "utf8"), /timed out before loadout readiness/);

      const lateResourceExtensionPath = join(dir, "late-resource-extension.ts");
      writeFileSync(
        lateResourceExtensionPath,
        `export default function(pi: any) { pi.on("resources_discover", async () => { await new Promise<void>(() => setInterval(() => {}, 1000)); }); }\n`,
      );
      const lateReadyPath = join(dir, "late-resource.ready");
      const lateSessionPath = join(dir, "late-resource.jsonl");
      const lateExitPath = `${lateSessionPath}.exit`;
      const lateCommand = [
        "exec pi --no-session --no-extensions --tools read",
        `-e ${shellEscape(SUBAGENT_DONE)}`,
        `-e ${shellEscape(lateResourceExtensionPath)}`,
        `-e ${shellEscape(TOOL_POLICY)}`,
        "--model openai/probe --print",
        shellEscape("Say only PROBE_OK"),
      ].join(" ");
      const lateRun = await runShell(
        buildStartupDeadlineCommand({
          command: lateCommand,
          readyFile: lateReadyPath,
          exitFile: lateExitPath,
          timeoutMs: 5000,
          escape: shellEscape,
        }),
        {
          ...env,
          PI_SUBAGENT_SESSION: lateSessionPath,
          PI_SUBAGENT_READY_FILE: lateReadyPath,
          PI_SUBAGENT_STARTUP_DEADLINE_MS: String(Date.now() + 5000),
        },
        10_000,
      );
      assert.equal(lateRun.status, 0, lateRun.stderr);
      assert.equal(
        readFileSync(lateReadyPath, "utf8"),
        "validated",
        "session_start validation is not full startup readiness",
      );
      assert.equal(
        modelRequestCount(),
        requestsAfterSuccessfulRun,
        "resources discovery must finish before the first model request",
      );
      assert.match(readFileSync(lateExitPath, "utf8"), /timed out before loadout readiness/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
