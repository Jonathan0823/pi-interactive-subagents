export const EXPLICIT_LOADOUT_STARTUP_TIMEOUT_MS = 30_000;

export interface StartupDeadlineCommandOptions {
  command: string;
  readyFile: string;
  exitFile: string;
  timeoutMs: number;
  escape: (value: string) => string;
}

/** Run a child until it reports readiness, or terminate it before model work can begin. */
export function buildStartupDeadlineCommand(options: StartupDeadlineCommandOptions): string {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Explicit subagent startup timeout must be a positive integer.");
  }

  const checks = Math.ceil(options.timeoutMs / 100);
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
    'rm -f "$ready_file" "$exit_file"',
    `bash -c ${options.escape(options.command)} <&0 &`,
    "child_pid=$!",
    "checks=0",
    `while kill -0 "$child_pid" 2>/dev/null && ! grep -qx ready "$ready_file" 2>/dev/null && [ "$checks" -lt ${checks} ]; do`,
    "  sleep 0.1",
    "  checks=$((checks + 1))",
    "done",
    `if [ "$checks" -ge ${checks} ] && ! grep -qx ready "$ready_file" 2>/dev/null && kill -0 "$child_pid" 2>/dev/null; then`,
    `  printf '%s\\n' ${options.escape(timeoutPayload)} > "$exit_file"`,
    '  kill -TERM "$child_pid" 2>/dev/null || true',
    "  sleep 1",
    '  kill -KILL "$child_pid" 2>/dev/null || true',
    "fi",
    'wait "$child_pid"',
    "status=$?",
    "echo '__SUBAGENT_DONE_'$status'__'",
  ].join("\n");
}
