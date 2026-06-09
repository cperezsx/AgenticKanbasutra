# Support

AgenticKanbasutra is currently a preview extension.

## Questions

Use GitHub issues for reproducible bugs, setup problems, runner configuration failures, feature requests, and documentation gaps:

https://github.com/cperezsx/AgenticKanbasutra/issues

## Bug Reports

When reporting a bug, include:

- VS Code version.
- AgenticKanbasutra version.
- Operating system.
- Runner used.
- Queue mode.
- Permission profile.
- Isolation mode.
- A concise reproduction.
- Relevant non-sensitive logs or artifact summaries.

Do not paste secrets, provider tokens, private customer data, or proprietary code into public issues.

## Runner Failures

When reporting a failed runner task, include:

- Runner ID.
- Provider CLI version when applicable.
- Whether the provider setup check passes.
- Queue mode.
- Permission profile.
- Isolation mode.
- Exit code.
- Sanitized stdout/stderr or failed-task summary.
- Whether the task used branch, commit, push, worktree, shell, MCP/tools, or cloud dispatch behavior.

## Security Reports

Do not open public issues for security vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Responsibility Notice

AgenticKanbasutra can orchestrate local commands and third-party agents. Users remain responsible for the tasks, runners, permissions, repositories, branches, generated changes, and provider usage they authorize. Read [DISCLAIMER.md](DISCLAIMER.md).
