# pi-interactive-subagents

Delegate tasks to agents in separate tmux panes while you keep working in [Pi](https://github.com/badlogic/pi-mono). Results arrive automatically when each agent finishes.

## Quick start

You need **Pi**, **tmux**, and credentials for a model you can use in Pi.

### 1. Install

Install this fork from GitHub:

```bash
pi install git:github.com/Jonathan0823/pi-interactive-subagents
```

### 2. Start Pi inside tmux

From your project directory:

```bash
tmux new -A -s pi
pi
```

Already inside tmux? Just start a new Pi session there.

### 3. Choose a model

Run `/subagents`, choose **scout**, and use **Change default** to save a model you have access to. Repeat for other agents you plan to use.

The bundled profiles currently use `openrouter/z-ai/glm-5.3`. You can change them without editing files.

### 4. Try your first task

Type this **inside Pi**, not your shell:

```text
/subagent scout Find where authentication is implemented and summarize the key files
```

A pane opens beside Pi without taking keyboard focus. You can keep working; a widget tracks progress, and the result arrives in your main conversation automatically.

## Everyday use

Ask Pi to delegate work in plain language:

> Have a scout map the test setup, then ask a worker to add tests for the login flow.

| Agent | Use it for |
| --- | --- |
| **scout** | Read-only codebase exploration |
| **worker** | Implementing changes and running commands |
| **researcher** | Web research with sources |

Researcher and worker web tools require separately installed extensions that provide them; this package does not include a web provider.

- **Start a task:** `/subagent <agent> <task>`
- **Choose models and thinking levels:** `/subagents` — **Spawn once** makes a one-off choice; **Change default** saves it.
- **Run tasks in parallel:** ask Pi to delegate several independent tasks.
- **Give more work to the same agent:** ask Pi to message it by name.

Names such as `scout` and `scout-2` identify each run. Messaging a running agent steers it; messaging a finished agent resumes it. **Completion notifications need no acknowledgement**—only send another message when you have more work.

If an agent asks a question, Pi can reply through `subagent_message`. That agent stays open while waiting for the answer.

## Make your own agent

Create `.pi/agents/reviewer.md` in your project:

```markdown
---
name: reviewer
description: Reviews changes for bugs
tools: read, grep, find, ls
system-prompt: append
auto-exit: true
---

Review the requested code for bugs. Do not edit files.
Report findings with file paths and suggested fixes.
```

Then run `/subagent reviewer Review the latest changes` inside Pi. With no `model` set, the agent uses Pi's configured default. You can choose a saved model through `/subagents`.

For agents shared across projects, put the file in `~/.pi/agent/agents/`. Project profiles override global and bundled profiles with the same name.

## More help

- [Tool parameters and commands](docs/reference.md#tools)
- [All agent profile options](docs/reference.md#frontmatter-reference)
- [Extensions, MCP, and access control](docs/reference.md#tool-access-control)
- [Status widget and configuration](docs/reference.md#status-widget--configuration)
- [Slow shell startup](docs/reference.md#how-it-works)

Agents can use real files, commands, and configured services. Tool restrictions are **not an OS sandbox**; read the [security limitations](docs/reference.md#explicit-loadouts-pi-140) before using advanced loadouts.

## Acknowledgements

This tmux-only fork builds on [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which also supports cmux, zellij, and WezTerm. Its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
