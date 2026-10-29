import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface ExplicitLoadoutProfile {
  /** Presence of either resource field opts into strict mode. */
  extensions?: string[];
  mcpServers?: string[];
  tools?: string[];
}

export interface RegisteredSubagentExtension {
  name: string;
  path: string;
  /** Non-secret stable version/digest covering code and approved effective configuration. */
  identity?: string;
  fingerprint?: string;
}

export interface ResolvedToolProvider {
  name: string;
  provider: string;
  contractFingerprint?: string;
  runnerManaged?: boolean;
}

export interface ResolvedExplicitLoadout {
  extensions: RegisteredSubagentExtension[];
  mcpServers: string[];
  toolProviders: ResolvedToolProvider[];
}

export interface ExplicitSubagentLoadout {
  version: 1;
  runtimeVersion: string;
  extensions: RegisteredSubagentExtension[];
  mcpServers: string[];
  toolProviders: ResolvedToolProvider[];
  runnerFiles: Array<{ path: string; fingerprint: string }>;
}

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

export function fingerprintExtension(path: string): string {
  if (!statSync(path).isFile()) throw new Error(`Registered extension "${path}" is not a file.`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprintToolContract(tool: { name: string; description: string; parameters: unknown }): string {
  const contract = stableSerialize({ name: tool.name, description: tool.description, parameters: tool.parameters });
  return createHash("sha256").update(contract).digest("hex");
}

export function createExplicitLoadoutSnapshot(
  resolved: ResolvedExplicitLoadout,
  runtimeVersion: string,
  managedProviders: readonly ResolvedToolProvider[],
  runnerPaths: readonly string[],
): ExplicitSubagentLoadout {
  const providers = new Map(resolved.toolProviders.map((tool) => [tool.name, { ...tool }]));
  for (const provider of managedProviders) {
    const existing = providers.get(provider.name);
    if (existing && existing.provider !== provider.provider) {
      throw new Error(`Runner-managed tool "${provider.name}" resolved to an unexpected provider.`);
    }
    if (existing) existing.runnerManaged = true;
    else providers.set(provider.name, { ...provider });
  }
  return {
    version: 1,
    runtimeVersion,
    extensions: resolved.extensions,
    mcpServers: resolved.mcpServers,
    toolProviders: [...providers.values()],
    runnerFiles: runnerPaths.map((path) => ({ path, fingerprint: fingerprintExtension(path) })),
  };
}

export function appendExplicitLoadoutArgs(
  parts: string[],
  loadout: ExplicitSubagentLoadout,
  toolAllowlist: string | null,
  policyExtensionPath: string,
  escape: (value: string) => string,
): void {
  parts.push("--no-extensions", "--no-mcp", "--tools", escape(toolAllowlist ?? "ask_question"));
  const extensionPaths = new Set(loadout.extensions.map((extension) => extension.path));
  for (const extension of loadout.extensions) parts.push("-e", escape(extension.path));
  const spawningToolNames = new Set(["subagent", "subagent_message", "subagents_list"]);
  for (const grant of loadout.toolProviders) {
    if (grant.runnerManaged && spawningToolNames.has(grant.name) && !extensionPaths.has(grant.provider)) {
      extensionPaths.add(grant.provider);
      parts.push("-e", escape(grant.provider));
    }
  }
  parts.push("-e", escape(policyExtensionPath));
}

const MCP_RUNTIME_UNAVAILABLE =
  "Selective MCP server loadouts are not supported by this subagent runner yet; no MCP servers were started.";

/** Resolve an explicitly opted-in profile without allowing it to inherit tools or resources. */
export function resolveExplicitLoadout(
  profile: ExplicitLoadoutProfile,
  registeredExtensions: readonly RegisteredSubagentExtension[],
  availableTools: readonly ResolvedToolProvider[],
): ResolvedExplicitLoadout {
  if ((profile.mcpServers ?? []).length > 0) {
    throw new Error(MCP_RUNTIME_UNAVAILABLE);
  }

  const extensions = (profile.extensions ?? []).map((name) => {
    if (!name || name.trim() !== name || name.includes(",") || /[*?]/.test(name)) {
      throw new Error(`Invalid extension reference "${name}"; use an exact registered name.`);
    }
    if (name === "builtin:mcp") {
      throw new Error(MCP_RUNTIME_UNAVAILABLE);
    }

    const matches = registeredExtensions.filter((extension) => extension.name === name);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Unknown or unsupported extension reference "${name}".`
          : `Ambiguous extension reference "${name}".`,
      );
    }
    if (matches[0].path.startsWith("builtin:")) return { ...matches[0], identity: matches[0].identity ?? matches[0].path };
    if (!matches[0].identity || matches[0].identity.trim() !== matches[0].identity) {
      throw new Error(`Registered extension "${name}" has no trusted registration identity.`);
    }
    return {
      ...matches[0],
      identity: matches[0].identity,
      fingerprint: fingerprintExtension(matches[0].path),
    };
  });

  const extensionNames = new Set<string>();
  for (const extension of extensions) {
    if (extensionNames.has(extension.name)) {
      throw new Error(`Duplicate extension reference "${extension.name}".`);
    }
    extensionNames.add(extension.name);
  }

  const requestedTools = profile.tools ?? [];
  const toolNames = new Set<string>();
  const toolProviders: ResolvedToolProvider[] = [];
  for (const name of requestedTools) {
    if (!name || name.trim() !== name || name.includes(",") || /[*?]/.test(name)) {
      throw new Error(`Exact tool names are required; "${name}" is not an exact tool name.`);
    }
    if (toolNames.has(name)) throw new Error(`Duplicate tool grant "${name}".`);
    toolNames.add(name);

    const matches = availableTools.filter((tool) => tool.name === name);
    if (matches.length === 0) throw new Error(`Tool grant "${name}" is not available in the parent runtime.`);
    if (matches.length !== 1) throw new Error(`Tool grant "${name}" has ambiguous providers.`);

    const provider = matches[0].provider;
    if (!matches[0].contractFingerprint) throw new Error(`Tool grant "${name}" has no verifiable tool contract.`);
    const isCoreBuiltin = BUILTIN_TOOLS.has(name) && provider === `builtin:${name}`;
    const selectedProvider = extensions.some((extension) => extension.path === provider);
    if (!isCoreBuiltin && !selectedProvider) {
      throw new Error(`Tool grant "${name}" is not provided by an explicitly selected resource.`);
    }
    if (name.startsWith("mcp__")) throw new Error(MCP_RUNTIME_UNAVAILABLE);
    toolProviders.push({ name, provider, contractFingerprint: matches[0].contractFingerprint });
  }

  return { extensions, mcpServers: [], toolProviders };
}

export interface ExplicitLoadoutValidationContext {
  runtimeVersion: string;
  registeredExtensions?: readonly RegisteredSubagentExtension[];
  requirePinnedContracts?: boolean;
  currentTools?: readonly ResolvedToolProvider[];
}

export function validateExplicitLoadoutSnapshot(
  snapshot: {
    version: number;
    runtimeVersion: string;
    extensions: readonly RegisteredSubagentExtension[];
    mcpServers: readonly string[];
    toolProviders: readonly ResolvedToolProvider[];
    runnerFiles: readonly { path: string; fingerprint: string }[];
  },
  context: ExplicitLoadoutValidationContext,
): void {
  const currentExtensions = context.registeredExtensions ?? [];

  if (snapshot.version !== 1) throw new Error("Unsupported explicit subagent loadout snapshot version.");
  if (!Array.isArray(snapshot.extensions) || !Array.isArray(snapshot.mcpServers) || snapshot.mcpServers.length > 0) {
    throw new Error("Invalid or unsupported explicit subagent loadout resources.");
  }
  if (!Array.isArray(snapshot.toolProviders) || !Array.isArray(snapshot.runnerFiles)) {
    throw new Error("Explicit subagent loadout is missing its provider-bound policy snapshot.");
  }
  if (snapshot.runtimeVersion !== context.runtimeVersion) {
    throw new Error("Pi runtime changed; a fresh subagent spawn is required.");
  }
  if (context.requirePinnedContracts && snapshot.toolProviders.some((grant) => !grant.contractFingerprint)) {
    throw new Error("Subagent tool contracts were not pinned; a fresh subagent spawn is required.");
  }
  if (context.currentTools) {
    const grants = snapshot.toolProviders.filter((grant) => grant.contractFingerprint);
    validateToolProviderGrants(grants, context.currentTools);
  }
  for (const file of snapshot.runnerFiles) {
    let currentFingerprint: string;
    try {
      currentFingerprint = fingerprintExtension(file.path);
    } catch {
      throw new Error("Subagent policy code is unavailable; a fresh subagent spawn is required.");
    }
    if (!file.fingerprint || file.fingerprint !== currentFingerprint) {
      throw new Error("Subagent policy code changed; a fresh subagent spawn is required.");
    }
  }
  for (const extension of snapshot.extensions) {
    if (extension.path.startsWith("builtin:")) {
      if (extension.identity && extension.identity !== extension.path) {
        throw new Error(`Built-in extension "${extension.name}" changed identity.`);
      }
      continue;
    }
    if (!extension.identity || extension.identity.trim() !== extension.identity) {
      throw new Error(`Selected extension "${extension.name}" has no trusted registration identity.`);
    }
    const current = currentExtensions.find((candidate) => candidate.name === extension.name);
    if (!current || !current.identity || current.path !== extension.path || current.identity !== extension.identity) {
      throw new Error(`Selected extension "${extension.name}" changed identity; a fresh subagent spawn is required.`);
    }
    let currentFingerprint: string;
    try {
      currentFingerprint = fingerprintExtension(extension.path);
    } catch {
      throw new Error(`Selected extension "${extension.name}" is unavailable; a fresh subagent spawn is required.`);
    }
    if (!extension.fingerprint || currentFingerprint !== extension.fingerprint) {
      throw new Error(`Selected extension "${extension.name}" changed; a fresh subagent spawn is required.`);
    }
  }
}

export function authorizeToolCall(
  name: string,
  grants: readonly ResolvedToolProvider[],
  availableTools: readonly ResolvedToolProvider[],
): { allowed: true } | { allowed: false; reason: string } {
  const grant = grants.find((candidate) => candidate.name === name);
  if (!grant) return { allowed: false, reason: `Tool "${name}" is not granted.` };
  const matches = availableTools.filter((tool) => tool.name === name);
  if (
    matches.length !== 1 ||
    matches[0].provider !== grant.provider ||
    !grant.contractFingerprint ||
    matches[0].contractFingerprint !== grant.contractFingerprint
  ) {
    return { allowed: false, reason: `Tool "${name}" provider or contract changed, or is ambiguous.` };
  }
  return { allowed: true };
}

/** Verify that a launch or resume still exposes each exact grant from its pinned provider. */
export function validateToolProviderGrants(
  grants: readonly ResolvedToolProvider[],
  availableTools: readonly ResolvedToolProvider[],
): void {
  for (const grant of grants) {
    const matches = availableTools.filter((tool) => tool.name === grant.name);
    if (matches.length === 0) throw new Error(`Granted tool "${grant.name}" is unavailable.`);
    if (matches.length !== 1) throw new Error(`Granted tool "${grant.name}" has ambiguous providers.`);
    if (!grant.contractFingerprint) throw new Error(`Granted tool "${grant.name}" has no pinned contract.`);
    if (matches[0].provider !== grant.provider || matches[0].contractFingerprint !== grant.contractFingerprint) {
      throw new Error(`Granted tool "${grant.name}" changed provider or contract; a fresh subagent spawn is required.`);
    }
  }
}
