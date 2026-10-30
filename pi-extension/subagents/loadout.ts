import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { McpServerIdentity } from "./mcp-identity.ts";

export interface ChildOnlyExtension {
  path: string;
  fingerprint: string;
}

export interface ExplicitLoadoutProfile {
  /** Presence of either resource field opts into strict mode. */
  extensions?: string[];
  mcpServers?: string[];
  subagentOnlyExtensions?: ChildOnlyExtension[];
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
  /** Exact configured MCP server when provider is the generic built-in MCP extension. */
  mcpServer?: string;
  contractFingerprint?: string;
  runnerManaged?: boolean;
}

export interface ResolvedExplicitLoadout {
  extensions: RegisteredSubagentExtension[];
  subagentOnlyExtensions: ChildOnlyExtension[];
  mcpServers: string[];
  mcpServerFingerprints: McpServerIdentity[];
  toolProviders: ResolvedToolProvider[];
}

export interface ExplicitSubagentLoadout {
  version: 1;
  runtimeVersion: string;
  extensions: RegisteredSubagentExtension[];
  subagentOnlyExtensions?: ChildOnlyExtension[];
  mcpServers: string[];
  /** Allowlisted non-secret configuration fingerprints; never contains credentials. */
  mcpServerFingerprints?: McpServerIdentity[];
  toolProviders: ResolvedToolProvider[];
  runnerFiles: Array<{ path: string; fingerprint: string }>;
}

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);
export const CHILD_ONLY_EXTENSION_PROVIDER = "subagent-only-extension";

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
  const contract = stableSerialize({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  return createHash("sha256").update(contract).digest("hex");
}

/** Snapshot runtime tools consistently in the parent and child policy. */
export function snapshotToolProviders(tools: readonly any[]): ResolvedToolProvider[] {
  return tools.map((tool) => {
    const source = tool.sourceInfo?.path;
    if (typeof source !== "string" || !source) {
      throw new Error(`Pi did not report a provider identity for tool "${tool.name}".`);
    }
    const provider = source.startsWith("builtin:") ? source : resolve(source);
    let mcpServer: string | undefined;
    if (typeof tool.name === "string" && tool.name.startsWith("mcp__")) {
      const aliases = tool.namespace?.aliases;
      const matches = Array.isArray(aliases)
        ? aliases.filter(
            (alias: unknown): alias is string =>
              typeof alias === "string" && tool.name.startsWith(`mcp__${alias.replace(/[^a-zA-Z0-9_]/g, "_")}__`),
          )
        : [];
      // Leave unidentified MCP tools unbound; explicit grant resolution rejects them.
      if (provider === "builtin:mcp" && matches.length === 1) mcpServer = matches[0];
    }
    return {
      name: tool.name,
      provider,
      ...(mcpServer ? { mcpServer } : {}),
      contractFingerprint: fingerprintToolContract({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters,
      }),
    };
  });
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
    subagentOnlyExtensions: resolved.subagentOnlyExtensions,
    mcpServers: resolved.mcpServers,
    ...(resolved.mcpServerFingerprints.length > 0 ? { mcpServerFingerprints: resolved.mcpServerFingerprints } : {}),
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
  parts.push("--no-extensions");
  if (loadout.mcpServers.length === 0) parts.push("--no-mcp");
  else parts.push("-e", escape("builtin:mcp"));
  parts.push("--tools", escape(toolAllowlist ?? "ask_question"));
  const extensionPaths = new Set(loadout.extensions.map((extension) => extension.path));
  for (const extension of loadout.extensions) parts.push("-e", escape(extension.path));
  for (const extension of loadout.subagentOnlyExtensions ?? []) {
    if (!extensionPaths.has(extension.path)) {
      extensionPaths.add(extension.path);
      parts.push("-e", escape(extension.path));
    }
  }
  const spawningToolNames = new Set(["subagent", "subagent_message", "subagents_list"]);
  for (const grant of loadout.toolProviders) {
    if (grant.runnerManaged && spawningToolNames.has(grant.name) && !extensionPaths.has(grant.provider)) {
      extensionPaths.add(grant.provider);
      parts.push("-e", escape(grant.provider));
    }
  }
  // Load policy last so its before_agent_start validation follows async tool registration by selected extensions.
  parts.push("-e", escape(policyExtensionPath));
}

const GENERIC_MCP_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "tool_search",
]);

function normalizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Expand `mcp:server` and `mcp:server/tool` profile selectors into exact runtime tool names. */
export function expandMcpToolSelectors(
  requestedTools: readonly string[],
  availableTools: readonly ResolvedToolProvider[],
): { tools: string[]; servers: string[] } {
  const tools: string[] = [];
  const servers: string[] = [];
  const seenTools = new Set<string>();
  const seenServers = new Set<string>();

  const addTool = (name: string) => {
    if (!seenTools.has(name)) {
      seenTools.add(name);
      tools.push(name);
    }
  };

  for (const requested of requestedTools) {
    if (!requested.startsWith("mcp:")) {
      addTool(requested);
      continue;
    }

    const selector = requested.slice("mcp:".length);
    const slash = selector.indexOf("/");
    const serverRef = slash < 0 ? selector : selector.slice(0, slash);
    const toolRef = slash < 0 ? undefined : selector.slice(slash + 1);
    if (!serverRef || (toolRef !== undefined && !toolRef)) {
      throw new Error(`Invalid MCP tool selector "${requested}".`);
    }

    const serverCandidates = [
      ...new Set(
        availableTools
          .filter((tool) => tool.provider === "builtin:mcp" && tool.mcpServer)
          .map((tool) => tool.mcpServer as string)
          .filter((name) => normalizeMcpName(name) === normalizeMcpName(serverRef)),
      ),
    ];
    if (serverCandidates.length !== 1) {
      throw new Error(`MCP server selector "${serverRef}" is not available or has an ambiguous identity.`);
    }
    const server = serverCandidates[0];
    if (!seenServers.has(server)) {
      seenServers.add(server);
      servers.push(server);
    }

    const prefix = `mcp__${normalizeMcpName(server)}__`;
    const candidates = availableTools.filter(
      (tool) => tool.provider === "builtin:mcp" && tool.mcpServer === server && tool.name.startsWith(prefix),
    );
    const matches =
      toolRef === undefined
        ? candidates
        : candidates.filter((tool) => tool.name === `${prefix}${normalizeMcpName(toolRef)}`);
    if (matches.length === 0) {
      throw new Error(`MCP tool selector "${requested}" is not available.`);
    }
    for (const match of matches) addTool(match.name);
  }

  return { tools, servers };
}

/** Resolve an explicitly opted-in profile without allowing it to inherit tools or resources. */
export function resolveExplicitLoadout(
  profile: ExplicitLoadoutProfile,
  registeredExtensions: readonly RegisteredSubagentExtension[],
  availableTools: readonly ResolvedToolProvider[],
  configuredMcpServers: readonly McpServerIdentity[] = [],
): ResolvedExplicitLoadout {
  const mcpServers = profile.mcpServers ?? [];
  const selectedMcpServers = new Set<string>();
  for (const name of mcpServers) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid MCP server reference "${name}".`);
    if (selectedMcpServers.has(name)) throw new Error(`Duplicate MCP server reference "${name}".`);
    selectedMcpServers.add(name);
  }
  const mcpServerFingerprints = mcpServers.map((name) => {
    const identities = configuredMcpServers.filter((server) => server.name === name);
    if (identities.length === 0) throw new Error(`MCP server "${name}" has no safe configuration identity.`);
    if (identities.length !== 1) throw new Error(`MCP server "${name}" has ambiguous configuration identities.`);
    if (!availableTools.some((tool) => tool.mcpServer === name)) {
      throw new Error(`MCP server "${name}" is unavailable in the parent runtime.`);
    }
    return { ...identities[0] };
  });

  const subagentOnlyExtensions = profile.subagentOnlyExtensions ?? [];
  const childExtensionPaths = new Set<string>();
  for (const extension of subagentOnlyExtensions) {
    if (!extension.path || !isAbsolute(extension.path)) {
      throw new Error("Subagent-only extension paths must be resolved absolute paths.");
    }
    if (childExtensionPaths.has(extension.path))
      throw new Error(`Duplicate subagent-only extension path "${extension.path}".`);
    childExtensionPaths.add(extension.path);
    if (
      !/^[a-f0-9]{64}$/.test(extension.fingerprint) ||
      fingerprintExtension(extension.path) !== extension.fingerprint
    ) {
      throw new Error(`Subagent-only extension identity is invalid or changed: ${extension.path}`);
    }
  }

  const extensions = (profile.extensions ?? []).map((name) => {
    if (!name || name.trim() !== name || name.includes(",") || /[*?]/.test(name)) {
      throw new Error(`Invalid extension reference "${name}"; use an exact registered name.`);
    }
    if (name === "builtin:mcp") {
      throw new Error('The generic built-in MCP extension is not a selectable resource; use "mcp_servers".');
    }

    const matches = registeredExtensions.filter((extension) => extension.name === name);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Unknown or unsupported extension reference "${name}".`
          : `Ambiguous extension reference "${name}".`,
      );
    }
    if (matches[0].path.startsWith("builtin:"))
      return { ...matches[0], identity: matches[0].identity ?? matches[0].path };
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
    if (matches.length === 0) {
      if (subagentOnlyExtensions.length > 0 && !name.startsWith("mcp__") && !GENERIC_MCP_TOOLS.has(name)) {
        toolProviders.push({ name, provider: CHILD_ONLY_EXTENSION_PROVIDER, runnerManaged: true });
        continue;
      }
      throw new Error(`Tool grant "${name}" is not available in the parent runtime.`);
    }
    if (matches.length !== 1) throw new Error(`Tool grant "${name}" has ambiguous providers.`);

    const tool = matches[0];
    if (!tool.contractFingerprint) throw new Error(`Tool grant "${name}" has no verifiable tool contract.`);
    if (GENERIC_MCP_TOOLS.has(name)) {
      throw new Error(`Generic MCP proxy/search tool "${name}" is not available in explicit loadouts.`);
    }

    if (tool.provider === "builtin:mcp") {
      if (!tool.mcpServer || !selectedMcpServers.has(tool.mcpServer)) {
        throw new Error(`Tool grant "${name}" is not provided by an explicitly selected resource.`);
      }
    } else {
      if (tool.mcpServer || name.startsWith("mcp__")) {
        throw new Error(`MCP tool "${name}" has an unexpected provider identity.`);
      }
      const isCoreBuiltin = BUILTIN_TOOLS.has(name) && tool.provider === `builtin:${name}`;
      const selectedProvider =
        extensions.some((extension) => extension.path === tool.provider) ||
        subagentOnlyExtensions.some((extension) => extension.path === tool.provider);
      if (!isCoreBuiltin && !selectedProvider) {
        throw new Error(`Tool grant "${name}" is not provided by an explicitly selected resource.`);
      }
    }
    toolProviders.push({
      name,
      provider: tool.provider,
      ...(tool.mcpServer ? { mcpServer: tool.mcpServer } : {}),
      contractFingerprint: tool.contractFingerprint,
    });
  }

  return { extensions, subagentOnlyExtensions, mcpServers, mcpServerFingerprints, toolProviders };
}

export interface ExplicitLoadoutValidationContext {
  runtimeVersion: string;
  registeredExtensions?: readonly RegisteredSubagentExtension[];
  requirePinnedContracts?: boolean;
  currentTools?: readonly ResolvedToolProvider[];
  currentMcpServers?: readonly McpServerIdentity[];
}

export function validateExplicitLoadoutSnapshot(
  snapshot: {
    version: number;
    runtimeVersion: string;
    extensions: readonly RegisteredSubagentExtension[];
    subagentOnlyExtensions?: readonly ChildOnlyExtension[];
    mcpServers: readonly string[];
    mcpServerFingerprints?: readonly McpServerIdentity[];
    toolProviders: readonly ResolvedToolProvider[];
    runnerFiles: readonly { path: string; fingerprint: string }[];
  },
  context: ExplicitLoadoutValidationContext,
): void {
  const currentExtensions = context.registeredExtensions ?? [];

  if (snapshot.version !== 1) throw new Error("Unsupported explicit subagent loadout snapshot version.");
  if (
    !Array.isArray(snapshot.extensions) ||
    !Array.isArray(snapshot.subagentOnlyExtensions ?? []) ||
    !Array.isArray(snapshot.mcpServers) ||
    snapshot.mcpServers.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) ||
    new Set(snapshot.mcpServers).size !== snapshot.mcpServers.length
  ) {
    throw new Error("Invalid explicit subagent loadout resources.");
  }
  const childExtensions = snapshot.subagentOnlyExtensions ?? [];
  if (
    childExtensions.some(
      (extension) =>
        !extension ||
        typeof extension.path !== "string" ||
        !isAbsolute(extension.path) ||
        typeof extension.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(extension.fingerprint),
    ) ||
    new Set(childExtensions.map((extension) => extension.path)).size !== childExtensions.length
  ) {
    throw new Error("Explicit subagent loadout has invalid child-only extension identities.");
  }
  for (const extension of childExtensions) {
    let currentFingerprint: string;
    try {
      currentFingerprint = fingerprintExtension(extension.path);
    } catch {
      throw new Error(`Subagent-only extension is unavailable; a fresh spawn is required: ${extension.path}`);
    }
    if (currentFingerprint !== extension.fingerprint) {
      throw new Error(`Subagent-only extension changed; a fresh spawn is required: ${extension.path}`);
    }
  }
  const mcpFingerprints = snapshot.mcpServerFingerprints ?? [];
  if (
    !Array.isArray(mcpFingerprints) ||
    mcpFingerprints.length !== snapshot.mcpServers.length ||
    mcpFingerprints.some(
      (server) =>
        !snapshot.mcpServers.includes(server.name) ||
        typeof server.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(server.fingerprint),
    ) ||
    new Set(mcpFingerprints.map((server) => server.name)).size !== mcpFingerprints.length
  ) {
    throw new Error("Explicit subagent loadout has missing or invalid MCP configuration identities.");
  }
  if (snapshot.mcpServers.length > 0) {
    if (!context.currentMcpServers) {
      throw new Error("Current MCP configuration identity is unavailable; a fresh subagent spawn is required.");
    }
    for (const expected of mcpFingerprints) {
      const matches = context.currentMcpServers.filter((server) => server.name === expected.name);
      if (matches.length !== 1 || matches[0].fingerprint !== expected.fingerprint) {
        throw new Error(
          `MCP server "${expected.name}" changed configuration identity; a fresh subagent spawn is required.`,
        );
      }
    }
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
    const grants = snapshot.toolProviders.filter((grant) => grant.contractFingerprint && !grant.runnerManaged);
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
    matches[0].mcpServer !== grant.mcpServer ||
    !grant.contractFingerprint ||
    matches[0].contractFingerprint !== grant.contractFingerprint
  ) {
    return {
      allowed: false,
      reason: `Tool "${name}" provider or contract changed, or is ambiguous.`,
    };
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
    if (
      matches[0].provider !== grant.provider ||
      matches[0].mcpServer !== grant.mcpServer ||
      matches[0].contractFingerprint !== grant.contractFingerprint
    ) {
      throw new Error(`Granted tool "${grant.name}" changed provider or contract; a fresh subagent spawn is required.`);
    }
  }
}
