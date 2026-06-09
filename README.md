# AgenticKanbasutra

> A preview VS Code extension for planning, queueing, running, and reviewing coding-agent tasks across local Git repositories.

[![Version](https://img.shields.io/badge/version-0.0.1-68f0a7)](CHANGELOG.md)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.92-65d8e9)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-f3bb58)](LICENSE)
[![Status](https://img.shields.io/badge/status-preview-c99cff)](#preview-status)

AgenticKanbasutra turns agent work into visible, repeatable tasks. Create a task with a repository, prompt, runner, model, permissions, branch, priority, and attached context; then move it through a focused Kanban workflow.

```text
PENDING -> QUEUED -> EXECUTION -> FAILED / DONE
```

It is designed for individual developers who want a safer command center for Copilot, Codex, Claude, manual handoffs, and custom local automation.

## Contents

- [Why Use It](#why-use-it)
- [Workflow](#workflow)
- [Task Board](#task-board)
- [Runners](#runners)
- [Queue Modes](#queue-modes)
- [Permissions And Isolation](#permissions-and-isolation)
- [Setup Checks](#setup-checks)
- [Configuration](#configuration)
- [Safety](#safety)
- [Support](#support)
- [Preview Status](#preview-status)
- [Author](#author)
- [Development](#development)
- [License](#license)

## Why Use It

- Keep agent tasks organized instead of losing prompts in chat history.
- Run tasks manually or automatically from a queue.
- Choose the right runner, model, permissions, and repository per task.
- Capture prompts, logs, summaries, diffs, changed files, and failure details.
- Requeue failed tasks after fixing authentication, quota, permissions, or configuration.
- Review generated work before accepting, merging, or publishing anything.

AgenticKanbasutra is not a replacement for code review, Git discipline, or human judgment. It orchestrates tools; you decide what is safe to run and what is safe to keep.

## Workflow

1. Open VS Code in or near a Git repository.
2. Open the AgenticKanbasutra Activity Bar view.
3. Click `New task`.
4. Select repository, branch, runner, model, tools, permissions, isolation mode, and priority.
5. Write the task SPEC and attach only the context that matters.
6. Save it to `PENDING`, move it to `QUEUED`, or run it directly.
7. Review the task in `DONE` or inspect and requeue it from `FAILED`.

## Task Board

The board has five columns:

| Column | Purpose |
| --- | --- |
| `PENDING` | Saved tasks that are not queued yet. |
| `QUEUED` | Tasks waiting for execution. |
| `EXECUTION` | Tasks currently running or waiting for manual output. |
| `FAILED` | Failed attempts that need review or requeue. |
| `DONE` | Completed, cancelled, or expired tasks. |

Drag and drop is intentionally limited:

- Move tasks between `PENDING` and `QUEUED`.
- Move `FAILED` tasks back to `PENDING` or `QUEUED`.
- `EXECUTION` and `DONE` are locked to avoid accidental state changes.

The board can also group tasks by repository or runner, which makes busy queues easier to scan without changing task status or execution order.

## Runners

| Runner | Use It For | Notes |
| --- | --- | --- |
| `manual` | Safe testing, external agents, interactive workflows. | Creates a prompt package and waits for you to paste the result. |
| `generic-cli` | Custom local automation. | Runs a configurable command template. |
| `copilot-cli` | Local GitHub Copilot CLI execution. | Captures output and maps configured permission arguments. |
| `copilot-cloud` | GitHub-hosted dispatch preview. | Dispatches work and waits for follow-up. Final sync is not implemented yet. |
| `claude-cli` | Local Claude Code CLI execution. | Runs `claude -p` in non-interactive mode with configurable permission arguments. |
| `codex-cli` | Local Codex CLI execution. | Runs `codex exec --json` and maps permission profiles to Codex sandbox modes. |
| `codex-cloud` | Codex Cloud dispatch preview. | Dispatches work through configured cloud settings. |
| `codex-manual` | Interactive Codex handoff. | Opens/copies a structured prompt and waits for manual completion. |

Recommended validation order:

1. `manual`
2. `generic-cli` with a harmless command
3. `copilot-cli`
4. `claude-cli`
5. `codex-cli`
6. Cloud runners after authentication and repository access are confirmed

## Queue Modes

Manual queue mode keeps queued tasks idle until you start them:

```json
"agenticKanbasutra.queue.executionMode": "manual"
```

Automatic queue mode starts queued tasks up to the configured concurrency limit:

```json
"agenticKanbasutra.queue.executionMode": "automatic",
"agenticKanbasutra.queue.maxConcurrent": 2
```

Queue order uses priority, manual rank, and enqueue time.

## Permissions And Isolation

Permission profiles:

| Profile | Meaning |
| --- | --- |
| `read_only` | Inspect and explain without writing files. |
| `ask` | Interactive approval workflows. Non-interactive runners reject it. |
| `allow_workspace` | Allow edits in the selected repository path. |
| `allow_worktree` | Allow edits in a task-specific Git worktree. |
| `bypass` | Explicit unrestricted mode for tasks that need Git metadata writes or broader tool access. |

Isolation modes:

| Mode | Meaning |
| --- | --- |
| `none` | No special isolation. |
| `workspace` | Execute directly in the selected repository. |
| `worktree` | Execute in a task-specific Git worktree when supported. |

Use `worktree` for write-capable agent runs when practical. Use `bypass` only when safer profiles cannot perform the required operation, such as branch, commit, or push tasks.

## Setup Checks

The extension includes setup reports for provider-backed runners:

- `AgenticKanbasutra: Check Copilot Setup`
- `AgenticKanbasutra: Check Claude Setup`
- `AgenticKanbasutra: Check Codex Setup`

These reports help confirm executable resolution, authentication signals, and local configuration before you run real tasks.

## Configuration

Common settings:

| Setting | Purpose |
| --- | --- |
| `agenticKanbasutra.queue.executionMode` | Manual or automatic queue execution. |
| `agenticKanbasutra.queue.maxConcurrent` | Maximum concurrent automatic tasks. |
| `agenticKanbasutra.completed.visible` | Show or hide completed tasks. |
| `agenticKanbasutra.completed.autoDelete.enabled` | Enable cleanup for completed tasks. |
| `agenticKanbasutra.artifacts.maxLogBytes` | Maximum captured log size before truncation. |
| `agenticKanbasutra.runners.genericCli.commandTemplate` | Command template for `generic-cli`. |
| `agenticKanbasutra.runners.copilotCli.*` | Copilot CLI executable and permission arguments. |
| `agenticKanbasutra.runners.claudeCli.*` | Claude CLI executable and permission arguments. |
| `agenticKanbasutra.runners.codexCli.*` | Codex CLI executable and base arguments. |
| `agenticKanbasutra.runners.toolsProfileOptions` | Shared tools/profile selector values. |

Provider CLIs must be installed and authenticated separately. AgenticKanbasutra does not install Copilot, Claude, Codex, GitHub CLI, MCP servers, or provider tools.

## Safety

AgenticKanbasutra can launch local commands and coding agents that may edit files, create branches, commit, push, or consume paid provider resources depending on your settings.

Use it carefully:

- Review prompts, summaries, logs, and diffs.
- Keep secrets out of task specs, notes, and attached context.
- Treat runner command templates as trusted code.
- Prefer isolated test repositories while validating setup.
- Keep destructive actions explicit.
- Do not run broad write-capable tasks without understanding the selected permissions.

You are responsible for the tasks you create, the runners you select, the permissions you grant, the changes produced, and any external provider usage. See [DISCLAIMER.md](DISCLAIMER.md) and [SECURITY.md](SECURITY.md).

## Support

- Report bugs and reproducible runner failures through GitHub Issues.
- Use feature requests for workflow, runner, UI, and Marketplace improvements.
- Do not open public issues for vulnerabilities or sensitive provider-token problems. Follow [SECURITY.md](SECURITY.md).
- Include the runner, repository mode, permission profile, queue mode, relevant logs, and expected behavior when reporting a problem.

## Preview Status

AgenticKanbasutra is an early preview.

Current limitations:

- Cloud runners dispatch work but do not yet poll or sync final results automatically.
- Worktree cleanup, merge/apply, and PR actions are not finished.
- Attempt history exists in storage, but the UI focuses on the latest run.
- Automated test coverage needs to grow before a stable release.
- Claude support currently targets the local `claude-cli` preview runner.

## Author

Carlos Perez  
GitHub: [@cperezsx](https://github.com/cperezsx)  
LinkedIn: [cperezsx](https://www.linkedin.com/in/cperezsx/)

## Development

Install dependencies:

```bash
npm install
```

Compile and validate:

```bash
npm run check
npm run package
```

Launch an Extension Development Host from VS Code with `F5`.

## License

MIT. See [LICENSE](LICENSE).
