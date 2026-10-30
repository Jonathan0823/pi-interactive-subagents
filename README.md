# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

`/subagents` provides an interactive model manager. It starts with the selected agent’s saved model and thinking level (or the parent’s current model and Pi’s configured thinking default when unset). **Spawn once** uses the chosen pair for that spawn only; **Change default** saves both together to a project-local or global agent profile. Thinking choices follow the selected model’s capabilities; for an unlisted model, Pi applies its own capability handling. Choosing **Pi default / unset** removes the profile’s `thinking` field.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `thinking` | string or `null` | agent's thinking setting | Override the level for this spawn; `null` leaves it to Pi's configured default |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`). They also set `fallback-model: pi-default`: if the configured model ends with a provider/agent error, the extension retries once with the parent session's currently selected model.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, mcp:context-mode/ctx_search
# Optional: opt into strict provider-bound tool checks and named extensions.
# mcp selectors expand to exact runtime tool grants; they do not isolate connections.
extensions: builtin:codemode
mcp_servers:
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `fallback-model` | `pi-default` | Retry once with the parent session's current model after a provider/agent error. Pi CLI agents only; no retry if the parent model is unavailable or identical to the primary model |
| `thinking` | string | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (subject to model support); omit for Pi's configured default |
| `tools` | string | Tool allowlist. In explicit-loadout mode, exact names are checked against pinned providers and tool-contract fingerprints. `mcp:<server>` selects that server's currently available direct tools; `mcp:<server>/<tool>` selects one tool and expands to its exact canonical name. |
| `extensions` | string | Optional comma-separated exact resource names. Presence opts into strict explicit-loadout mode, even when empty. Built-in extension names are discovered from Pi's registered tools (for example `builtin:codemode`). Third-party extensions may register a stable name, entrypoint, and identity; custom registered extensions currently require the same working directory as the parent. |
| `subagentOnlyExtensions` | string/list | Child-only Pi extension entrypoints. Paths may be absolute, `~/...`, or relative to the child working directory. The file fingerprint is saved and checked on resume. For a restricted child, list permitted extension tools in `tools`; omitting `tools` in a legacy profile keeps its normal default toolset. |
| `mcp_servers` | string | Optional comma-separated exact configured MCP server names. Presence opts into strict mode. `tools` must name exact canonical MCP tools from these servers, or use `mcp:<server>` / `mcp:<server>/<tool>` selectors. This scopes tool grants, not server connections. |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Legacy profiles (without `extensions`, `mcp_servers`, or an `mcp:` tool selector) retain their earlier behavior. In particular, legacy `--tools` is not a nested-call authorization policy. `subagentOnlyExtensions` loads child-specific entrypoints but does not opt into strict authorization by itself.

### Child-only extensions

Use `subagentOnlyExtensions` to load Pi extension entrypoints only in the child. Paths resolve relative to the child's working directory; absolute and `~/...` paths are also supported. The selected files are fingerprinted in the session loadout and must remain unchanged on resume. Extension loading and tool authorization are separate: restricted children must list permitted tools in `tools`; omitting `tools` on a legacy profile retains the normal unrestricted default toolset.

```markdown
subagentOnlyExtensions:
  - ./tools/web-access.ts
extensions:
tools: read, web_search, fetch_content
```

In strict mode, each requested child-only tool must be registered by one of the selected entrypoints; its provider path and tool contract are pinned during child startup. A harness-only tool such as `ffgrep` is not automatically a Pi child tool. Use Pi's built-in `grep`/`find` or load a real Pi extension that registers the desired tools. This package does not bundle a web provider; `pi-web-access` is a separate Pi extension that can be selected here after installation.

### Explicit loadouts (Pi 1.4.0+)

Presence of `extensions`, `mcp_servers`, or an `mcp:` selector in `tools` selects strict mode. `extensions: builtin:codemode` explicitly loads Pi's codemode extension; list exact `tools` separately to authorize calls. For example:

```markdown
extensions: builtin:codemode
tools: read, grep, codemode, mcp:context-mode/ctx_search
```

Strict mode disables extension discovery and authorizes every direct or codemode-mediated tool call by exact name, provider identity, and pinned tool-contract fingerprint (description and parameter schema). For MCP, `mcp_servers` scopes which configured server may contribute a grant. The `mcp:<server>` selector expands to that server's currently available direct tools, while `mcp:<server>/<tool>` selects one; both are resolved into exact canonical tool names before launch. Unknown, ambiguous, unselected, or changed server/tool identities fail closed. Unscoped MCP resource and search proxies are not granted. Empty `mcp_servers:` explicitly disables MCP; a non-empty list explicitly loads Pi's built-in MCP extension.

**MCP selection is not connection isolation.** Pi uses the child's normal trusted MCP configuration and may connect every enabled server in it, not only the selected server. Other enabled servers may access their configured credentials and the network even though their tools are not granted to the child. Do not run strict-loadout children with MCP configurations you do not trust; tool authorization is not an OS sandbox. Loadout snapshots store only SHA-256 fingerprints of an allowlisted non-secret configuration projection, never raw MCP configuration or credential values. Secret-bearing environment/header values and URL credentials, query strings, and fragments are excluded; ambiguous config sources or configurations that cannot be fingerprinted safely fail closed. Tests use inert local fixtures and no live secrets. Legacy profiles are not affected.

Third-party extensions can register an exact subagent resource after this extension has loaded:

```ts
(globalThis as any).__pi_interactive_subagents?.registerSubagentExtension(
  "my-extension",
  fileURLToPath(import.meta.url),
  "my-extension@1.2.3",
);
```

The identity must be a non-secret stable version/digest string and must change when the extension's code **and approved non-secret effective configuration** change. The identity is resolved from the parent's trusted registration, not from profile data; a profile cannot authenticate its own provider. Registration must be performed by an already trusted parent extension; this API does not consult Pi's trust database. Explicit custom extensions are currently supported only when the child uses the parent working directory. Pi does not expose a generic secret-safe configuration/trust fingerprint here, so do not register providers whose effective behavior depends on unpinned external settings. Pi resource configuration/trust resolution and selected-only MCP connection isolation are not provided by this extension.

Strict child startup has a 30-second readiness deadline. Provider and pinned-contract validation happens during startup, but the initial prompt remains gated through extension and direct MCP tool discovery; the final ready marker is written before the prompt can reach the model. Missing or changed providers fail closed, and a child that does not become ready by the deadline is terminated. Resume revalidates the runtime, registered identity, entrypoint digest, selected MCP configuration fingerprints, granted tool contracts, and policy code before accepting further work. The deadline bounds startup, not arbitrary behavior after readiness; this is not an OS sandbox. An external configuration/trust fingerprint contract is still needed before using providers whose effective behavior depends on opaque external settings.

Strict loadout snapshots are versioned, mode `0600`, and contain no raw MCP configuration or credentials; they store only safe configuration fingerprints. Resume fails closed if the runtime, runner policy code, selected extension identity/entrypoint, MCP configuration fingerprint, or a granted tool contract changes. An explicit profile never silently inherits parent resources. Runtime-managed `ask_question` and explicitly permitted `subagent_agents` controls remain narrowly granted.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
