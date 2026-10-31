/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandPaths = new Map<string, string | null>();

function resolveCommand(command: string): string | undefined {
  if (commandPaths.has(command)) return commandPaths.get(command) ?? undefined;

  const executable = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => resolve(directory || process.cwd(), command))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  commandPaths.set(command, executable ?? null);
  return executable;
}

function hasCommand(command: string): boolean {
  return resolveCommand(command) !== undefined;
}

function tmuxExecutable(): string {
  const executable = resolveCommand("tmux");
  if (!executable) throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  return executable;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  const escapedQuote = String.raw`'\''`;
  return `'${s.replaceAll("'", escapedQuote)}'`;
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync(tmuxExecutable(), ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  _name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  // tmux panes are not named; retain the argument for API compatibility.
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync(tmuxExecutable(), args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync(tmuxExecutable(), ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync(tmuxExecutable(), ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ?? join(tmpdir(), "pi-subagent-scripts", `cmd-${randomBytes(8).toString("hex")}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, `${scriptParts.join("\n")}\n`, {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(tmuxExecutable(), ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`], {
    encoding: "utf8",
  });
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    tmuxExecutable(),
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync(tmuxExecutable(), ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Child process exit code. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /** Non-provider watcher failure that must not trigger configured model fallback. */
  error?: string;
  shutdownRequestedAt?: number;
  shutdownElapsedMs?: number;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions do not write
 * this provider-error sidecar; ordinary completion uses a separate durable process-exit sidecar.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: unknown): PollResult {
  if (typeof data === "object" && data !== null && "type" in data && data.type === "error") {
    const errorMessage =
      "errorMessage" in data && typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar, readProcessExitSidecar, checkShutdownRequestTimeout };

/**
 * Poll until the subagent exits. Checks provider-error and process-exit
 * sidecars first, using the terminal sentinel as a compatibility fallback.
 */
function readExitSidecar(sessionFile?: string): PollResult | undefined {
  if (!sessionFile) return undefined;
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return undefined;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return undefined;
  }
}

function checkShutdownRequestTimeout(
  requestFile: string | undefined,
  timeoutMs: number | undefined,
  now = Date.now(),
  processExitFile?: string,
): PollResult | undefined {
  if (!requestFile || timeoutMs == null) return undefined;
  try {
    const request = JSON.parse(readFileSync(requestFile, "utf-8"));
    if (typeof request?.requestedAt !== "number" || !Number.isFinite(request.requestedAt)) return undefined;
    if (now - request.requestedAt < timeoutMs) return undefined;
    return (
      readProcessExitSidecar(processExitFile) ?? {
        reason: "error",
        exitCode: 124,
        error: "shutdown-timeout",
        shutdownRequestedAt: request.requestedAt,
        shutdownElapsedMs: now - request.requestedAt,
      }
    );
  } catch {
    return undefined;
  }
}

function readProcessExitSidecar(processExitFile?: string): PollResult | undefined {
  if (!processExitFile) return undefined;
  try {
    const data = JSON.parse(readFileSync(processExitFile, "utf-8"));
    if (typeof data !== "object" || data === null || data.type !== "process_exit") return undefined;
    if (!Number.isInteger(data.exitCode)) return undefined;
    return { reason: "sentinel", exitCode: data.exitCode };
  } catch {
    return undefined;
  }
}

async function waitForPollInterval(signal: AbortSignal, interval: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, interval);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function checkSentinelFile(sentinelFile?: string): PollResult | undefined {
  if (!sentinelFile) return undefined;
  try {
    if (existsSync(sentinelFile)) return { reason: "sentinel", exitCode: 0 };
  } catch {
    // A missing or inaccessible sentinel is not an exit signal.
  }
  return undefined;
}

function parseTerminalSentinel(screen: string): PollResult | undefined {
  const match = /__SUBAGENT_DONE_(\d+)__/.exec(screen);
  return match ? { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) } : undefined;
}

async function checkTerminalExit(surface: string, sessionFile?: string): Promise<PollResult | undefined> {
  try {
    return parseTerminalSentinel(await readScreenAsync(surface, 5));
  } catch {
    // Surface may have been destroyed — check if .exit file appeared in the meantime.
    return readExitSidecar(sessionFile);
  }
}

async function checkPollExit(
  surface: string,
  options: {
    sessionFile?: string;
    processExitFile?: string;
    shutdownRequestFile?: string;
    shutdownTimeoutMs?: number;
    now?: () => number;
    sentinelFile?: string;
  },
): Promise<PollResult | undefined> {
  return (
    readExitSidecar(options.sessionFile) ??
    readProcessExitSidecar(options.processExitFile) ??
    checkShutdownRequestTimeout(
      options.shutdownRequestFile,
      options.shutdownTimeoutMs,
      options.now?.() ?? Date.now(),
      options.processExitFile,
    ) ??
    checkSentinelFile(options.sentinelFile) ??
    (await checkTerminalExit(surface, options.sessionFile))
  );
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    processExitFile?: string;
    shutdownRequestFile?: string;
    shutdownTimeoutMs?: number;
    now?: () => number;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const result = await checkPollExit(surface, options);
    if (result) return result;

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    // Polling is inherently sequential: each check follows the prior interval.
    await waitForPollInterval(signal, options.interval); // NOSONAR
  }
}
