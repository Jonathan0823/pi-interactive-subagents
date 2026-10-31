import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CompletionMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/** Publish a child result and wake the parent without messaging the finished child. */
export function publishSubagentCompletion(
  pi: Pick<ExtensionAPI, "sendMessage">,
  message: CompletionMessage,
  pendingNames: readonly string[],
): void {
  // A triggered steer is only queued while the parent streams and can be
  // discarded by Esc. Publish the actual result independently: Pi flushes
  // context-only custom messages at turn_end, including after an abort.
  pi.sendMessage(message, { triggerTurn: false });
  // Only the disposable wake-up lives in the steering queue. If it is cleared,
  // the next user turn still has the recorded result; never undo a user abort.
  try {
    pi.sendMessage(
      {
        customType: "subagent_completion_wakeup",
        content:
          "New subagent result recorded above. Do not acknowledge completion via subagent_message; " +
          "that resumes the finished child. " +
          completionTurnGuidance(pendingNames),
        display: false,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // The result is already published. A failed wake-up must not turn a
    // successful child into another failure notification or a resume loop.
  }
}

/** Parent turn guidance is a snapshot, not a reason to wait inside a model response. */
export function completionTurnGuidance(pendingNames: readonly string[]): string {
  if (pendingNames.length === 0) {
    return "No subagents remain running. Summarize the completed results for the user now; do not silently stop.";
  }
  const label = pendingNames.length === 1 ? "subagent still running" : "subagents still running";
  return (
    `At notification time, ${pendingNames.length} ${label}: ${pendingNames.join(", ")}. ` +
    "If you have no independent work, briefly report progress to the user and end this turn immediately. " +
    "Do not wait in reasoning for another completion, poll, or keep generating waiting text. " +
    "Do not message a child just to check or hurry it. Its result will trigger another turn automatically. " +
    "Newer completion notifications supersede this pending count."
  );
}
