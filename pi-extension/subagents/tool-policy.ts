import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  authorizeToolCall,
  snapshotToolProviders,
  validateToolProviderGrants,
  type ResolvedToolProvider,
} from "./loadout.ts";

interface ExplicitLoadoutPolicy {
  version: 1;
  toolProviders: ResolvedToolProvider[];
}

function currentProviders(pi: any): ResolvedToolProvider[] {
  if (typeof pi.getAllTools !== "function") {
    throw new Error("This Pi runtime does not expose the tool metadata required for strict subagent permissions.");
  }
  return snapshotToolProviders(pi.getAllTools());
}

function assertStartupDeadline(): void {
  const deadline = Number(process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error("Explicit subagent startup deadline is missing or invalid.");
  }
  if (Date.now() > deadline) {
    throw new Error("Explicit subagent startup deadline expired before initial input.");
  }
}

function writeReadinessState(path: string, state: "validated" | "ready"): void {
  writeFileSync(path, state, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function createToolPolicyHandlers(
  grants: readonly ResolvedToolProvider[],
  getProviders: () => ResolvedToolProvider[],
  onPinned?: (grants: readonly ResolvedToolProvider[]) => void,
  onReady?: () => void,
  onValidated?: () => void,
) {
  const effectiveGrants = grants.map((grant) => ({ ...grant }));
  let validated = false;
  let ready = false;
  let startupError: string | undefined;
  return {
    start(ctx: { shutdown(): void }): string | undefined {
      try {
        const providers = getProviders();
        let pinned = false;
        for (const grant of effectiveGrants) {
          if (grant.contractFingerprint) continue;
          if (!grant.runnerManaged) throw new Error(`Tool grant "${grant.name}" has no pinned contract.`);
          const matches = providers.filter((provider) => provider.name === grant.name);
          if (matches.length !== 1 || matches[0].provider !== grant.provider || !matches[0].contractFingerprint) {
            throw new Error(`Runner-managed tool "${grant.name}" has an unexpected provider or contract.`);
          }
          grant.contractFingerprint = matches[0].contractFingerprint;
          pinned = true;
        }
        validateToolProviderGrants(effectiveGrants, providers);
        if (pinned) onPinned?.(effectiveGrants);
        onValidated?.();
        validated = true;
        return undefined;
      } catch (error) {
        startupError = String(error);
        ctx.shutdown();
        return startupError;
      }
    },
    handleInput(ctx?: { shutdown(): void }) {
      if (!validated) return { action: "handled" as const };
      if (ready) return { action: "continue" as const };
      try {
        validateToolProviderGrants(effectiveGrants, getProviders());
        onReady?.();
        ready = true;
        return { action: "continue" as const };
      } catch (error) {
        startupError = String(error);
        ctx?.shutdown();
        return { action: "handled" as const };
      }
    },
    authorize(event: { toolName: string; parentToolCallId?: string }) {
      if (!ready) {
        return {
          block: true as const,
          reason: startupError ?? "Explicit subagent tool policy is not ready.",
        };
      }
      try {
        const decision = authorizeToolCall(event.toolName, effectiveGrants, getProviders());
        return decision.allowed ? undefined : { block: true as const, reason: decision.reason };
      } catch (error) {
        return {
          block: true as const,
          reason: `Explicit subagent tool policy failed closed: ${String(error)}`,
        };
      }
    },
  };
}

export default function subagentToolPolicy(pi: any): void {
  const policyPath = process.env.PI_SUBAGENT_LOADOUT_FILE;
  if (!policyPath) return;

  let policy: ExplicitLoadoutPolicy;
  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as {
      explicitLoadout?: ExplicitLoadoutPolicy;
    };
    policy = parsed.explicitLoadout as ExplicitLoadoutPolicy;
    if (policy?.version !== 1 || !Array.isArray(policy.toolProviders)) {
      throw new Error("Unsupported explicit subagent loadout policy.");
    }
  } catch (error) {
    throw new Error(`Cannot read explicit subagent loadout policy: ${String(error)}`);
  }

  const handlers = createToolPolicyHandlers(
    policy.toolProviders,
    () => currentProviders(pi),
    (toolProviders) => {
      const session = JSON.parse(readFileSync(policyPath, "utf8")) as {
        explicitLoadout: ExplicitLoadoutPolicy;
      };
      session.explicitLoadout.toolProviders = toolProviders.map((grant) => ({ ...grant }));
      writeFileSync(policyPath, JSON.stringify(session, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(policyPath, 0o600);
    },
    () => {
      const readinessPath = process.env.PI_SUBAGENT_READY_FILE;
      if (!readinessPath) return;
      assertStartupDeadline();
      writeReadinessState(readinessPath, "ready");
    },
    () => {
      const readinessPath = process.env.PI_SUBAGENT_READY_FILE;
      if (!readinessPath) return;
      assertStartupDeadline();
      writeReadinessState(readinessPath, "validated");
    },
  );
  pi.on("session_start", (_event: unknown, ctx: any) => {
    const error = handlers.start({ shutdown: () => ctx.shutdown() });
    if (error) {
      console.error(`Explicit subagent loadout rejected before tool use: ${error}`);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        try {
          const failurePath = `${sessionFile}.exit`;
          writeFileSync(
            failurePath,
            JSON.stringify({
              type: "error",
              errorMessage: "Explicit subagent loadout rejected before model use.",
            }),
            { encoding: "utf8", mode: 0o600 },
          );
          chmodSync(failurePath, 0o600);
        } catch {
          // The child still shuts down; failure to report it must not make it runnable.
        }
      }
    }
  });
  pi.on("input", (_event: unknown, ctx: any) => handlers.handleInput({ shutdown: () => ctx.shutdown() }));
  pi.on("tool_call", handlers.authorize);
}
