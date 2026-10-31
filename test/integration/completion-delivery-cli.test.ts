import { spawn, spawnSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";

const COMPLETION_MODULE = fileURLToPath(new URL("../../pi-extension/subagents/completion.ts", import.meta.url));
const MARKER = "CHILD_RESULT_SURVIVES_CANCELLATION";
// npm scripts prefer the legacy dev-dependency binary. CI and local runs can
// select the Pi 1.4+ runtime whose context-only publication contract we exercise.
const PI_EXECUTABLE = process.env.PI_TEST_PI_EXECUTABLE ?? "pi";
const version = spawnSync(PI_EXECUTABLE, ["--version"], { encoding: "utf8", timeout: 5000 });
assert.equal(version.status, 0, `Could not query Pi version: ${version.error ?? version.stderr}`);
const [major, minor] = version.stdout.trim().split(".").map(Number);
const cliOptions = {
  timeout: 20_000,
  skip:
    major < 1 || (major === 1 && minor < 4)
      ? "Completion persistence requires Pi 1.4+; set PI_TEST_PI_EXECUTABLE to that CLI."
      : false,
};
type RecordMessage = { type: string; id?: string; success?: boolean; data?: Record<string, unknown> };

function writeChunk(response: ServerResponse, content: string, finish = false) {
  const chunk = (delta: object, finishReason: string | null = null) => ({
    id: "chatcmpl-completion-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "probe",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ content }))}\n\n`);
  if (finish) {
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  }
}

async function createCompletionHarness(t: TestContext, holdFirstRequest = true) {
  const dir = mkdtempSync(join(tmpdir(), "pi-completion-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests: Array<{ body: { messages: unknown[] }; response: ServerResponse }> = [];
  let notifyRequest: (() => void) | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      requests.push({ body: JSON.parse(body), response });
      if (requests.length === 1 && holdFirstRequest) writeChunk(response, "PARENT_BUSY");
      else writeChunk(response, "SUMMARY_COMPLETE", true);
      notifyRequest?.();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configDir = join(dir, "config");
  mkdirSync(configDir);
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
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 128,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const fixture = join(dir, "completion-fixture.ts");
  writeFileSync(
    fixture,
    `
import { publishSubagentCompletion } from ${JSON.stringify(COMPLETION_MODULE)};
export default function(pi: any) {
  pi.registerCommand("emit-test-completion", {
    description: "Publish a simulated child completion during a real parent response",
    handler() {
      publishSubagentCompletion(pi, {
        customType: "subagent_result", content: ${JSON.stringify(MARKER)}, display: true,
        details: { name: "Worker" },
      }, []);
    },
  });
}
`,
  );
  const sessionFile = join(dir, "parent.jsonl");
  const env = { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
  const child = spawn(
    PI_EXECUTABLE,
    [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--tools",
      "",
      "--model",
      "openai/probe",
      "--session",
      sessionFile,
      "-e",
      fixture,
    ],
    { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const records: RecordMessage[] = [];
  const waiters: Array<{
    predicate: (record: RecordMessage) => boolean;
    resolve: (record: RecordMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;
  const fail = (error: Error) => {
    terminalError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  child.on("error", fail);
  child.on("close", (code, signal) => fail(new Error(`Pi exited (${code ?? signal}): ${stderr}`)));
  let pending = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    pending += chunk;
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line) as RecordMessage;
      records.push(record);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(record)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(record);
        }
      }
    }
  });
  const waitFor = (predicate: (record: RecordMessage) => boolean) => {
    const existing = records.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (terminalError) return Promise.reject(terminalError);
    return new Promise<RecordMessage>((resolve, reject) => waiters.push({ predicate, resolve, reject }));
  };
  let sequence = 0;
  const command = async (type: string, args: object = {}) => {
    const id = `command-${++sequence}`;
    const response = waitFor((record) => record.type === "response" && record.id === id);
    child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
    const result = await response;
    assert.equal(result.success, true, `${JSON.stringify(result)}\n${stderr}`);
    return result;
  };
  await command("get_state");
  return {
    command,
    waitFor,
    requests,
    sessionFile,
    records,
    requestStarted: () => {
      if (requests.length > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        notifyRequest = resolve;
      });
    },
  };
}

it("preserves a completion when the parent wake-up is cleared and its response aborted", cliOptions, async (t) => {
  const harness = await createCompletionHarness(t);
  await harness.command("prompt", { message: "Start the parent response." });
  await harness.requestStarted();
  await harness.command("prompt", { message: "/emit-test-completion" });
  await harness.command("clear_queue");
  await harness.command("abort");

  const state = await harness.command("get_state");
  assert.equal(state.data?.isStreaming, false, "cancelling must not automatically restart the parent");
  assert.equal(harness.requests.length, 1);
  const entries = readFileSync(harness.sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const completions = entries.filter(
    (entry) => entry.type === "custom_message" && entry.customType === "subagent_result",
  );
  assert.equal(completions.length, 1, "the result must survive clearing the steer queue and aborting");
  assert.equal(completions[0].content, MARKER);

  await harness.command("prompt", { message: "Summarize the completed child results." });
  await harness.waitFor((record) => record.type === "agent_settled" && harness.requests.length === 2);
  assert.equal(harness.requests.length, 2);
  assert.match(JSON.stringify(harness.requests[1].body.messages), new RegExp(MARKER));
});

it("includes a published completion in the queued wake-up's model request exactly once", cliOptions, async (t) => {
  const harness = await createCompletionHarness(t);
  await harness.command("prompt", { message: "Start the parent response." });
  await harness.requestStarted();
  await harness.command("prompt", { message: "/emit-test-completion" });
  writeChunk(harness.requests[0].response, "PARENT_TURN_ENDED", true);
  await harness.waitFor((record) => record.type === "agent_settled");

  assert.equal(harness.requests.length, 2);
  const context = JSON.stringify(harness.requests[1].body.messages);
  assert.equal(context.split(MARKER).length - 1, 1, "wake-up must see the result without repeating it");
  assert.match(context, /No subagents remain running/);
  const messages = harness.records.filter((record) => record.type === "message_end");
  assert.ok(messages.length > 0);
});

it("records an idle parent's completion before the wake-up starts a new request", cliOptions, async (t) => {
  const harness = await createCompletionHarness(t, false);
  await harness.command("prompt", { message: "/emit-test-completion" });
  await harness.waitFor((record) => record.type === "agent_settled");

  assert.equal(harness.requests.length, 1);
  assert.equal(JSON.stringify(harness.requests[0].body.messages).split(MARKER).length - 1, 1);
  const entries = readFileSync(harness.sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const resultIndex = entries.findIndex(
    (entry) => entry.type === "custom_message" && entry.customType === "subagent_result",
  );
  const wakeIndex = entries.findIndex(
    (entry) => entry.type === "custom_message" && entry.customType === "subagent_completion_wakeup",
  );
  assert.ok(resultIndex >= 0 && wakeIndex > resultIndex, "the published result must precede its disposable wake-up");
});
