import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface McpServerIdentity {
  name: string;
  /** Hash of an allowlisted non-secret configuration projection; raw config and credentials are never persisted. */
  fingerprint: string;
}

export interface RegisteredMcpServerConfig {
  name: string;
  config: unknown;
}

interface McpConfigSource {
  label: string;
  servers: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    const serializedEntries = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",");
    return `{${serializedEntries}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizedServerName(name: string): string {
  return name.replaceAll(/[^\w]/gu, "_");
}

function readConfigSource(path: string, label: string): McpConfigSource | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot safely resolve MCP server identity from ${label}: ${String(error)}`);
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`Cannot safely resolve MCP server identity from ${label}: invalid mcpServers object.`);
  }
  return { label, servers: (parsed.mcpServers as Record<string, unknown> | undefined) ?? {} };
}

function checkedArgs(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string")) {
    throw new Error(`MCP server "${name}" has arguments that cannot be safely fingerprinted.`);
  }
  const args = value as string[];
  const secretFlag = /(?:token|secret|password|api[-_]?key|authorization|credential)/iu;
  for (const arg of args) {
    const looksLikePath = arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../");
    if (
      secretFlag.test(arg) ||
      /\bBearer\s+\S+/iu.test(arg) ||
      (!looksLikePath && /^[A-Za-z0-9_+/=-]{40,}$/.test(arg))
    ) {
      throw new Error(`MCP server "${name}" has secret-like arguments that cannot be safely fingerprinted.`);
    }
  }
  return args;
}

function hasOnlyStringValues(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function hasValidConfigValueShapes(config: Record<string, unknown>): boolean {
  return (
    (config.env === undefined || hasOnlyStringValues(config.env)) &&
    (config.headers === undefined || hasOnlyStringValues(config.headers)) &&
    (config.toolExposure === undefined || hasOnlyStringValues(config.toolExposure)) &&
    (config.oauth === undefined || isRecord(config.oauth)) &&
    (config.auth === undefined ||
      (isRecord(config.auth) && Object.keys(config.auth).every((key) => key === "provider"))) &&
    (config.description === undefined || typeof config.description === "string") &&
    (config.enabled === undefined || typeof config.enabled === "boolean") &&
    (config.timeout === undefined || typeof config.timeout === "number") &&
    (config.cwd === undefined || typeof config.cwd === "string")
  );
}

function validateOAuthConfig(name: string, oauth: unknown): void {
  if (!isRecord(oauth)) return;
  const oauthKeys = new Set([
    "clientId",
    "clientSecret",
    "callbackPort",
    "callbackUrl",
    "scope",
    "clientName",
    "clientRegistration",
    "authServerMetadataUrl",
  ]);
  if (Object.keys(oauth).some((key) => !oauthKeys.has(key))) {
    throw new Error(`MCP server "${name}" has OAuth fields that cannot be safely fingerprinted.`);
  }
}

function validateConfigShape(
  name: string,
  config: Record<string, unknown>,
  hasCommand: boolean,
  transport: "stdio" | "http",
): void {
  const allowedKeys = new Set([
    "type",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "oauth",
    "auth",
    "enabled",
    "timeout",
    "exposure",
    "description",
    "toolExposure",
  ]);
  const wrongTransportKeys = hasCommand ? ["url", "headers", "oauth", "auth"] : ["args", "env", "cwd"];
  const hasUnsupportedFields =
    Object.keys(config).some((key) => !allowedKeys.has(key)) ||
    wrongTransportKeys.some((key) => config[key] !== undefined) ||
    (config.type !== undefined && config.type !== transport);
  if (hasUnsupportedFields) {
    throw new Error(`MCP server "${name}" has configuration fields that cannot be safely fingerprinted.`);
  }
  if (!hasValidConfigValueShapes(config)) {
    throw new Error(`MCP server "${name}" has an invalid configuration shape.`);
  }
  validateOAuthConfig(name, config.oauth);
}

/**
 * Fingerprint only stable, allowlisted configuration. Secret-bearing values from env, headers,
 * OAuth, URL credentials, query strings, and fragments are deliberately omitted; only env/header
 * key names and public OAuth settings participate. The returned digest is the only persisted value.
 */
function addStdioIdentity(
  identity: Record<string, unknown>,
  name: string,
  config: Record<string, unknown>,
  command: string,
  workingDirectory: string,
): void {
  if (/token|secret|password|api[-_]?key|authorization|credential/iu.test(command)) {
    throw new Error(`MCP server "${name}" has a command that cannot be safely fingerprinted.`);
  }
  identity.type = config.type ?? "stdio";
  identity.command = command;
  identity.cwd = resolve(workingDirectory, typeof config.cwd === "string" ? config.cwd : ".");
  identity.args = checkedArgs(name, config.args);
}

function addHttpIdentity(
  identity: Record<string, unknown>,
  name: string,
  config: Record<string, unknown>,
  url: string,
): void {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error(`MCP server "${name}" has an invalid URL.`);
  }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error(`MCP server "${name}" URL cannot be safely fingerprinted.`);
  }
  identity.type = config.type ?? "http";
  identity.endpoint = {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname.toLowerCase(),
    port: endpoint.port,
    pathFingerprint: createHash("sha256").update(endpoint.pathname).digest("hex"),
  };
  const oauth = isRecord(config.oauth) ? config.oauth : {};
  identity.oauth = Object.fromEntries(
    ["clientId", "callbackPort", "callbackUrl", "scope", "clientName", "clientRegistration", "authServerMetadataUrl"]
      .filter((key) => oauth[key] !== undefined)
      .map((key) => [key, oauth[key]]),
  );
  identity.authProvider = isRecord(config.auth) ? (config.auth.provider ?? null) : null;
}

export function fingerprintMcpServerConfig(name: string, rawConfig: unknown, workingDirectory = process.cwd()): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || !isRecord(rawConfig)) {
    throw new Error(`MCP server "${name}" has an invalid configuration identity.`);
  }
  const config = rawConfig;
  if (config.enabled === false) throw new Error(`MCP server "${name}" is disabled.`);

  const command = typeof config.command === "string" && config.command.length > 0 ? config.command : undefined;
  const url = typeof config.url === "string" && config.url.length > 0 ? config.url : undefined;
  const hasCommand = command !== undefined;
  const hasUrl = url !== undefined;
  if (hasCommand === hasUrl) {
    throw new Error(`MCP server "${name}" has an ambiguous transport configuration.`);
  }
  const transport = hasCommand ? "stdio" : "http";
  validateConfigShape(name, config, hasCommand, transport);

  const identity: Record<string, unknown> = {
    name,
    transport,
    enabled: config.enabled !== false,
    timeout: config.timeout ?? null,
    exposure: config.exposure ?? "codemode",
    description: config.description ?? null,
    toolExposure: config.toolExposure ?? {},
    envKeys: isRecord(config.env) ? Object.keys(config.env).toSorted((a, b) => a.localeCompare(b)) : [],
    headerKeys: isRecord(config.headers)
      ? Object.keys(config.headers)
          .map((key) => key.toLowerCase())
          .toSorted((a, b) => a.localeCompare(b))
      : [],
  };

  if (command !== undefined) addStdioIdentity(identity, name, config, command, workingDirectory);
  else addHttpIdentity(identity, name, config, url as string);

  return createHash("sha256").update(stableSerialize(identity)).digest("hex");
}

/**
 * Resolve each selected server to exactly one configured source and fingerprint its safe projection.
 * If user, project, and extension registrations make the source ambiguous, resolution fails closed.
 */
export function resolveMcpServerIdentities(
  names: readonly string[],
  options: {
    agentDir: string;
    cwd: string;
    registeredServers?: readonly RegisteredMcpServerConfig[];
  },
): McpServerIdentity[] {
  if (names.length === 0) return [];
  const sources = [
    readConfigSource(join(options.agentDir, "mcp.json"), "agent mcp.json"),
    readConfigSource(join(options.cwd, ".pi", "mcp.json"), "project .pi/mcp.json"),
  ].filter((source): source is McpConfigSource => source !== undefined);

  return names.map((name) => {
    const configured = sources.flatMap((source) =>
      Object.hasOwn(source.servers, name) ? [{ label: source.label, config: source.servers[name] }] : [],
    );
    const registered = (options.registeredServers ?? []).filter((server) => server.name === name);
    const matches = [
      ...configured,
      ...registered.map((server) => ({ label: "registered MCP server", config: server.config })),
    ];
    if (matches.length === 0) throw new Error(`MCP server "${name}" is not configured or registered.`);
    if (matches.length !== 1) {
      const labels = matches.map((match) => match.label).join(", ");
      throw new Error(`MCP server "${name}" has ambiguous configuration sources: ${labels}.`);
    }

    const collisions = [
      ...sources.flatMap((source) => Object.keys(source.servers)),
      ...(options.registeredServers ?? []).map((server) => server.name),
    ].filter((candidate) => candidate !== name && normalizedServerName(candidate) === normalizedServerName(name));
    if (collisions.length > 0) {
      throw new Error(`MCP server "${name}" has an ambiguous normalized identity with "${collisions[0]}".`);
    }

    return { name, fingerprint: fingerprintMcpServerConfig(name, matches[0].config, options.cwd) };
  });
}
