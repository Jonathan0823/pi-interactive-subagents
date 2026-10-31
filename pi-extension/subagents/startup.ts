export const EXPLICIT_LOADOUT_STARTUP_TIMEOUT_MS = 30_000;

export interface StartupDeadlineCommandOptions {
  command: string;
  readyFile: string;
  exitFile: string;
  processExitFile?: string;
  shutdownRequestFile?: string;
  timeoutMs: number;
  escape: (value: string) => string;
}

/** Wrap a child command with a durable, atomic process-exit record. */
export function buildProcessExitCommand(
  command: string,
  processExitFile: string,
  shellQuote: (value: string) => string,
  shutdownRequestFile?: string,
): string {
  const tempFile = `${processExitFile}.$$`;
  return [
    "set +e",
    "umask 077",
    `process_exit_file=${shellQuote(processExitFile)}`,
    `process_exit_tmp=${shellQuote(tempFile)}`,
    ...(shutdownRequestFile ? [`shutdown_request_file=${shellQuote(shutdownRequestFile)}`] : []),
    shutdownRequestFile
      ? 'rm -f "$process_exit_file" "$process_exit_tmp" "$shutdown_request_file"'
      : 'rm -f "$process_exit_file" "$process_exit_tmp"',
    `bash -c ${shellQuote(command)} <&0`,
    "status=$?",
    `printf '{"type":"process_exit","exitCode":%s}\\n' "$status" > "$process_exit_tmp"`,
    'mv -f "$process_exit_tmp" "$process_exit_file"',
    "echo '__SUBAGENT_DONE_'$status'__'",
  ].join("\n");
}

/** Run a child until it reports readiness, or terminate it before model work can begin. */
export function buildStartupDeadlineCommand(options: StartupDeadlineCommandOptions): string {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Explicit subagent startup timeout must be a positive integer.");
  }

  const checks = Math.ceil(options.timeoutMs / 100);
  const sessionPrefix = options.exitFile.endsWith(".exit") ? options.exitFile.slice(0, -5) : options.exitFile;
  const processExitFile = options.processExitFile ?? `${sessionPrefix}.process-exit`;
  const shutdownRequestFile = options.shutdownRequestFile ?? `${sessionPrefix}.shutdown-request`;
  const processExitTempFile = `${processExitFile}.$$`;
  const timeoutPayload = JSON.stringify({
    type: "error",
    errorMessage: "Explicit subagent startup timed out before loadout readiness.",
  });

  // Preserve the tmux pane's stdin; asynchronous Bash jobs otherwise read from /dev/null.
  return [
    "set +e",
    "umask 077",
    `ready_file=${options.escape(options.readyFile)}`,
    `exit_file=${options.escape(options.exitFile)}`,
    `process_exit_file=${options.escape(processExitFile)}`,
    `process_exit_tmp=${options.escape(processExitTempFile)}`,
    `shutdown_request_file=${options.escape(shutdownRequestFile)}`,
    'rm -f "$ready_file" "$exit_file" "$process_exit_file" "$process_exit_tmp" "$shutdown_request_file"',
    `bash -c ${options.escape(options.command)} <&0 &`,
    "child_pid=$!",
    "checks=0",
    `while kill -0 "$child_pid" 2>/dev/null && ! grep -qx ready "$ready_file" 2>/dev/null && [ ! -s "$exit_file" ] && [ "$checks" -lt ${checks} ]; do`,
    "  sleep 0.1",
    "  checks=$((checks + 1))",
    "done",
    `if [ "$checks" -ge ${checks} ] && ! grep -qx ready "$ready_file" 2>/dev/null && [ ! -s "$exit_file" ] && kill -0 "$child_pid" 2>/dev/null; then`,
    String.raw`  printf '%s\n' ${options.escape(timeoutPayload)} > "$exit_file"`,
    "fi",
    `if [ -s "$exit_file" ] && kill -0 "$child_pid" 2>/dev/null; then`,
    '  kill -TERM "$child_pid" 2>/dev/null || true',
    "  sleep 1",
    '  kill -KILL "$child_pid" 2>/dev/null || true',
    "fi",
    'wait "$child_pid"',
    "status=$?",
    `printf '{"type":"process_exit","exitCode":%s}\\n' "$status" > "$process_exit_tmp"`,
    'mv -f "$process_exit_tmp" "$process_exit_file"',
    "echo '__SUBAGENT_DONE_'$status'__'",
  ].join("\n");
}
