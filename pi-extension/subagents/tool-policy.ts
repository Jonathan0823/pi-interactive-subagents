import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveMcpServerIdentities, type McpServerIdentity } from "./mcp-identity.ts";
import {
  authorizeToolCall,
  CHILD_ONLY_EXTENSION_PROVIDER,
  snapshotToolProviders,
  validateToolProviderGrants,
  type ResolvedToolProvider,
} from "./loadout.ts";

interface ExplicitLoadoutPolicy {
  version: 1;
  mcpServers?: string[];
  mcpServerFingerprints?: McpServerIdentity[];
  subagentOnlyExtensions?: Array<{ path: string; fingerprint: string }>;
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

function writeReadinessState(path: string, state: "pending" | "validated" | "ready"): void {
  writeFileSync(path, state, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function createToolPolicyHandlers(
  grants: readonly ResolvedToolProvider[],
  getProviders: () => ResolvedToolProvider[],
  onPinned?: (grants: readonly ResolvedToolProvider[]) => void,
  onReady?: () => void,
  onValidated?: () => void,
  validateMcpConfiguration?: () => void,
  childOnlyExtensionPaths: readonly string[] = [],
  onPending?: () => void,
) {
  const effectiveGrants = grants.map((grant) => ({ ...grant }));
  const hasMcpGrants = effectiveGrants.some((grant) => Boolean(grant.mcpServer));
  const deferredChildOnlyGrants = new Set<ResolvedToolProvider>();
  let validated = false;
  let ready = false;
  let startupError: string | undefined;
  return {
    start(ctx: { shutdown(): void }): string | undefined {
      deferredChildOnlyGrants.clear();
      try {
        validateMcpConfiguration?.();
        const providers = getProviders();
        let pinned = false;
        for (const grant of effectiveGrants) {
          const matches = providers.filter((provider) => provider.name === grant.name);
          if (grant.contractFingerprint) {
            if (childOnlyExtensionPaths.includes(grant.provider) && matches.length === 0) {
              deferredChildOnlyGrants.add(grant);
            }
            continue;
          }
          if (!grant.runnerManaged) throw new Error(`Tool grant "${grant.name}" has no pinned contract.`);
          if (grant.provider === CHILD_ONLY_EXTENSION_PROVIDER) {
            if (matches.length === 0) {
              deferredChildOnlyGrants.add(grant);
              continue;
            }
            if (
              matches.length !== 1 ||
              !childOnlyExtensionPaths.includes(matches[0].provider) ||
              !matches[0].contractFingerprint
            ) {
              throw new Error(`Child-only extension tool "${grant.name}" has an unexpected provider or contract.`);
            }
            grant.provider = matches[0].provider;
          } else if (
            matches.length !== 1 ||
            matches[0].provider !== grant.provider ||
            !matches[0].contractFingerprint
          ) {
            throw new Error(`Runner-managed tool "${grant.name}" has an unexpected provider or contract.`);
          }
          grant.contractFingerprint = matches[0].contractFingerprint;
          pinned = true;
        }
        validateToolProviderGrants(
          effectiveGrants.filter((grant) => !grant.mcpServer && !deferredChildOnlyGrants.has(grant)),
          providers,
        );
        if (pinned) onPinned?.(effectiveGrants);
        if (deferredChildOnlyGrants.size === 0 && !hasMcpGrants) {
          onValidated?.();
          validated = true;
        } else {
          onPending?.();
        }
        return undefined;
      } catch (error) {
        startupError = String(error);
        ctx.shutdown();
        return startupError;
      }
    },
    handleInput(ctx?: { shutdown(): void }) {
      if (startupError) return { action: "handled" as const };
      if (!validated) {
        return deferredChildOnlyGrants.size > 0 || hasMcpGrants
          ? { action: "continue" as const }
          : { action: "handled" as const };
      }
      if (ready || hasMcpGrants) return { action: "continue" as const };
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
    async beforeAgentStart(ctx?: { shutdown(): void }): Promise<string | undefined> {
      if (ready || (deferredChildOnlyGrants.size === 0 && !hasMcpGrants)) return undefined;
      try {
        const deadline = Number(process.env.PI_SUBAGENT_STARTUP_DEADLINE_MS);
        if (!Number.isSafeInteger(deadline) || deadline <= 0) {
          throw new Error("Explicit subagent startup deadline is missing or invalid.");
        }
        let pinned = false;
        while (true) {
          const providers = getProviders();
          const pendingChildOnly: ResolvedToolProvider[] = [];
          for (const grant of deferredChildOnlyGrants) {
            const matches = providers.filter((provider) => provider.name === grant.name);
            if (matches.length > 1)
              throw new Error(`Child-only extension tool "${grant.name}" has ambiguous providers.`);
            if (matches.length === 0) {
              pendingChildOnly.push(grant);
              continue;
            }
            const provider = matches[0];
            if (!childOnlyExtensionPaths.includes(provider.provider) || !provider.contractFingerprint) {
              throw new Error(`Child-only extension tool "${grant.name}" has an unexpected provider or contract.`);
            }
            if (grant.provider === CHILD_ONLY_EXTENSION_PROVIDER) grant.provider = provider.provider;
            else if (grant.provider !== provider.provider) {
              throw new Error(`Child-only extension tool "${grant.name}" changed provider.`);
            }
            if (!grant.contractFingerprint) {
              grant.contractFingerprint = provider.contractFingerprint;
              pinned = true;
            }
          }
          const pendingMcp = hasMcpGrants
            ? effectiveGrants.filter(
                (grant) => grant.mcpServer && !providers.some((provider) => provider.name === grant.name),
              )
            : [];
          if (pendingChildOnly.length === 0 && pendingMcp.length === 0) {
            validateToolProviderGrants(effectiveGrants, providers);
            break;
          }
          if (Date.now() >= deadline) {
            const pending = pendingChildOnly[0] ?? pendingMcp[0];
            throw new Error(`Granted tool "${pending.name}" is unavailable.`);
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        }
        if (pinned) onPinned?.(effectiveGrants);
        onValidated?.();
        validated = true;
        if (!ready) onReady?.();
        ready = true;
        deferredChildOnlyGrants.clear();
        return undefined;
      } catch (error) {
        startupError = String(error);
        ctx?.shutdown();
        return startupError;
      }
    },
    failureReason(): string | undefined {
      return startupError;
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
    () => {
      const names = policy.mcpServers ?? [];
      const expected = policy.mcpServerFingerprints ?? [];
      if (names.length === 0) {
        if (expected.length !== 0) throw new Error("Unexpected MCP configuration identities in an empty loadout.");
        return;
      }
      if (typeof pi.getMcpServers !== "function") {
        throw new Error("This Pi runtime does not expose configured MCP server identities.");
      }
      const current = resolveMcpServerIdentities(names, {
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
        cwd: process.cwd(),
        registeredServers: pi.getMcpServers(),
      });
      for (const name of names) {
        const expectedMatches = expected.filter((server) => server.name === name);
        const currentMatches = current.filter((server) => server.name === name);
        if (
          expectedMatches.length !== 1 ||
          currentMatches.length !== 1 ||
          expectedMatches[0].fingerprint !== currentMatches[0].fingerprint
        ) {
          throw new Error(`MCP server "${name}" changed configuration identity; a fresh subagent spawn is required.`);
        }
      }
    },
    (policy.subagentOnlyExtensions ?? []).map((extension) => extension.path),
    () => {
      const readinessPath = process.env.PI_SUBAGENT_READY_FILE;
      if (!readinessPath) return;
      assertStartupDeadline();
      writeReadinessState(readinessPath, "pending");
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
              errorMessage: `Explicit subagent loadout rejected before model use: ${error}`,
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
  pi.on("before_agent_start", async (_event: unknown, ctx: any) => {
    const error = await handlers.beforeAgentStart({ shutdown: () => ctx.shutdown() });
    if (!error) return;
    console.error(`Explicit subagent loadout rejected before model use: ${error}`);
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    try {
      const failurePath = `${sessionFile}.exit`;
      writeFileSync(
        failurePath,
        JSON.stringify({
          type: "error",
          errorMessage: `Explicit subagent loadout rejected before model use: ${error}`,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(failurePath, 0o600);
    } catch {
      // The child still shuts down; failure to report it must not make it runnable.
    }
  });
  pi.on("input", async (_event: unknown, ctx: any) => {
    const result = await handlers.handleInput({ shutdown: () => ctx.shutdown() });
    if (result.action === "handled") {
      const reason = handlers.failureReason() ?? "startup validation failed.";
      console.error(`Explicit subagent loadout rejected before model use: ${reason}`);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        try {
          const failurePath = `${sessionFile}.exit`;
          writeFileSync(
            failurePath,
            JSON.stringify({
              type: "error",
              errorMessage: `Explicit subagent loadout rejected before model use: ${reason}`,
            }),
            { encoding: "utf8", mode: 0o600 },
          );
          chmodSync(failurePath, 0o600);
        } catch {
          // The child still shuts down; failure to report it must not make it runnable.
        }
      }
    }
    return result;
  });
  pi.on("tool_call", handlers.authorize);
}
