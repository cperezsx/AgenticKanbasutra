# Changelog

All notable changes to AgenticKanbasutra will be documented in this file.

## 0.0.2

Focused preview update for denser boards and clearer Claude CLI model selection.

- Added collapse and expand controls for Kanban groups when the board is grouped by repository or runner.
- Added collapse and expand controls for the sidebar Summary, Configuration, and Recent work sections.
- Persisted board grouping and collapse state inside the webview state so visual preferences survive rerenders.
- Added explicit Claude CLI model choices in the New task composer: Claude Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6, and Haiku 4.5.
- Kept `auto` available for Claude CLI so Claude Code can continue using `/model default`, expected as Claude Sonnet 4.6 unless the local Claude configuration overrides it.
- Updated release documentation, Marketplace-facing copy, and manual QA checklist for the new compact navigation workflow.

## 0.0.1

Initial MVP preview.

- Added VS Code extension scaffold.
- Added Activity Bar Kanban webview.
- Added fixed columns: Pending, Queued, Execution, Failed, Done.
- Added a dedicated Failed column with quick requeue for failed tasks.
- Added structured task creation and editing.
- Added priority-based queue ordering and manual queued-task reorder.
- Added manual and automatic queue execution modes with configurable concurrency.
- Added drag-and-drop between Pending and Queued, plus Failed recovery back to Pending or Queued.
- Added board grouping by repository or runner as a local visual preference.
- Added header close buttons to task edit and detail views.
- Added JSON-backed local persistence.
- Added manual handoff and generic CLI runners.
- Added prompt, stdout, stderr, summary, and Git diff artifacts.
- Added completed-task cleanup.
- Added English-first localization with initial Spanish strings.
- Added retro terminal-inspired icon and UI styling.
- Added resource-failure fallback handling for token, quota, auth, permission, configuration, and network failures.
- Added GitHub Copilot CLI runner.
- Added robust Copilot CLI and GitHub CLI executable resolution on Windows.
- Added Copilot CLI preflight validation for remote push tasks blocked by configured permission arguments.
- Added GitHub Copilot Cloud dispatch runner.
- Added Copilot setup and runner guidance.
- Added Copilot setup readiness command and toolbar action.
- Added Claude CLI preview runner.
- Added Claude setup readiness command and toolbar action.
- Added Claude setup and runner guidance.
- Added Codex CLI runner.
- Added Codex CLI stdin handling and preflight guidance for Git metadata writes.
- Added Codex Cloud dispatch runner.
- Added Codex manual handoff runner.
- Added Codex setup readiness command and toolbar action.
- Added Codex setup and runner guidance.
- Added VS Code Status Bar summary and quick actions.
- Added queue mode and concurrency details to the Status Bar tooltip.
- Added artifact cleanup when tasks are deleted or expired.
- Added orchestrator-level log truncation for runner output.
- Added branch/base selection in the task editor.
- Added explicit task-card and detail visibility for runner, branch, isolation, and permission settings.
- Added basic task-specific Git worktree execution for local runners.
- Added run metadata for base branch, worktree path, and created worktree branch.
- Refined README and support files for Marketplace-style onboarding.
- Added a support guide for users, bug reports, and security escalation.
- Added explicit manual completion flow for waiting handoff tasks.
- Removed hardcoded sample agent profiles so selectors show defaults, discovered agents, or configured agents.
- Updated publishing documentation and roadmap, including future Claude support.
- Added a plain-language user responsibility disclaimer.
- Removed the dummy runner from the packaged runner registry after preview validation.
