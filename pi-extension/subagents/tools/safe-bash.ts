/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DANGEROUS_PATTERNS = [
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
];

function isDangerous(command: string): string | null {
  const normalized = command.replaceAll("\\\n", " ");
  const rmCommand = /\brm\s+(?:-[a-zA-Z]+\s+){0,2}(?:\/|~(?:\/|\s|$))/.test(normalized);
  if (rmCommand) {
    return "Command blocked by safe_bash: matches dangerous pattern rm recursive force root";
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}

export default function safeBash(pi: ExtensionAPI) {
  const bashTool = createBashTool(process.cwd());

  pi.registerTool({
    name: "safe_bash",
    label: "Safe Bash",
    description: "Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    execute(toolCallId, params, signal, onUpdate, _ctx) {
      const danger = isDangerous(params.command);
      if (danger) {
        throw new Error(danger);
      }
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
