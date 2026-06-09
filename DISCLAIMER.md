# User Responsibility Disclaimer

AgenticKanbasutra is an orchestration tool. It can prepare prompts, run local commands, dispatch provider CLIs, create worktrees, capture artifacts, and help you review agent output. It does not guarantee that an AI agent, CLI tool, shell command, or third-party provider will behave correctly.

By using this extension, you are responsible for:

- Reviewing every task before execution.
- Choosing safe runners, permission profiles, repositories, branches, and isolation modes.
- Understanding that `bypass`, unrestricted CLI settings, cloud agents, and custom commands can modify files, Git history, branches, remotes, and external services.
- Reviewing diffs, commits, logs, generated code, and remote changes before relying on them.
- Protecting secrets, credentials, customer data, proprietary code, and local system access.
- Complying with your organization policies, provider terms, licenses, laws, and security requirements.

AgenticKanbasutra stores local artifacts to make agent activity reviewable, but the user remains responsible for the actions they authorize and for any consequences of running agents or commands.

The extension is provided "as is", without warranty. See [LICENSE](LICENSE) for the full license terms.
