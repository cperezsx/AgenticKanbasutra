# Security Policy

## Supported versions

AgenticKanbasutra is currently a preview extension. Security fixes will target the latest published version.

## Reporting a vulnerability

Please report security issues privately to the maintainers before opening a public issue.

If a private channel has not been published yet, open a GitHub issue with a minimal, non-sensitive description and request a private follow-up channel.

## Execution safety

AgenticKanbasutra can run local commands through configured runners. Treat runner configuration as trusted code.

Current safety principles:

- Write-capable runners require Workspace Trust.
- Permission profiles are explicit.
- Generic CLI execution is configurable and should be reviewed before use.
- Artifacts are stored locally for auditability.
- Secrets must not be written into task specs, prompts, logs, or artifacts.
- Users are responsible for every runner, provider, command, permission profile, repository, branch, remote action, and generated change they authorize.

See [User Responsibility Disclaimer](DISCLAIMER.md) for the plain-language responsibility notice included with the extension.
