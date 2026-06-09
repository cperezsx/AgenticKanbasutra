# Contributing

Thanks for helping shape AgenticKanbasutra.

This project is a VS Code extension for managing agentic coding tasks through a fixed Kanban board. Contributions should keep the product practical, safe, and provider-adapter based.

## Project Language

English is the primary language for:

- Code.
- Documentation.
- Settings.
- Command IDs.
- Marketplace copy.
- Issues and pull requests.

Localized UI strings are welcome through `package.nls.*.json` files and webview dictionaries.

## Development Setup

```bash
npm install
npm run compile
```

Run the extension locally:

1. Open the repository in VS Code.
2. Press `F5`.
3. Use the Extension Development Host window.
4. Open the AgenticKanbasutra Activity Bar view.

## Before Opening A Pull Request

Run:

```bash
npm run check
npm run package
```

Also verify the affected workflow manually in an Extension Development Host.

## Branches And Pull Requests

Use `main` as the default branch. Create focused working branches using one of these prefixes:

- `feature/<short-topic>`
- `fix/<short-topic>`
- `docs/<short-topic>`
- `release/<version>`
- `hotfix/<short-topic>`

Pull request titles should use one of these prefixes:

- `[Feature]`
- `[Fix]`
- `[Docs]`
- `[Release]`
- `[Security]`

Keep one concern per pull request. Runner, queue, permission, worktree, and Marketplace changes should include manual QA notes.

## Contribution Areas

Good first contribution areas:

- Documentation clarity.
- Small UI polish.
- Runner setup diagnostics.
- Safer worktree lifecycle actions.
- Manual QA scenarios.
- Tests around queue ordering, validation, and failure categorization.

Larger contribution areas:

- New provider runners.
- Cloud task polling/sync.
- Apply/merge/PR flows for completed worktree runs.
- Storage migrations.

## Design Principles

- Keep the board dense, useful, and accessible.
- Prefer public VS Code APIs.
- Treat every provider as an adapter.
- Keep execution failures reviewable through artifacts.
- Keep destructive actions explicit.
- Avoid private Copilot, Codex, or VS Code extension internals.

## Runner Contributions

New runners should:

1. Implement the `AgentRunner` interface.
2. Register through the runner registry.
3. Validate required local tools and configuration.
4. Respect task permission profiles.
5. Preserve prompt/output artifacts.
6. Avoid changing the shared task model unless the field is provider-neutral.
7. Document setup and limitations.

## Documentation

Update docs when behavior changes:

- User-facing workflow changes -> `README.md`.
- Provider behavior -> update the relevant runner section in `README.md`.
- Architecture, tradeoffs, and release notes -> keep the public README concise and use local/private notes when needed.

## Issues

Use GitHub Issues for reproducible bugs, runner failures, and feature requests. Security vulnerabilities, token exposure, private repository data, or credential problems must follow `SECURITY.md` and must not be reported publicly.

## Security

Do not include secrets, local tokens, private repository data, generated artifacts, or personal machine paths in commits.

See [SECURITY.md](SECURITY.md).
