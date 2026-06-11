# Changelog

All notable changes to AgenticKanbasutra will be documented in this file.

## 0.0.5

- Added Claude `/usage` health parsing before `auth status`, so Claude provider health can show real current-session and weekly usage percentages plus reset times.
- Kept Claude `auth status` as the fallback readiness signal when `/usage` is unavailable or cannot return usage details.
- Made Claude `/usage` parsing tolerant of mixed stdout/stderr output, bullet separators, and reset times without minutes, with sidebar labels that show session remaining time and weekly remaining usage.
- Changed Claude CLI resolution on Windows to prefer the native `claude.exe` binary behind the npm shim, avoiding shell interpretation of Markdown prompts that start with `#`.
- Refined Claude model suggestions to prioritize Claude Code aliases (`fable`, `sonnet`, `opus`, `haiku`) and observed/configured model IDs instead of speculative version-specific IDs.
- Expanded the Claude setup report with auth status, `/usage` output, and safer model-selection guidance.

## 0.0.4

Provider usage time display fix for clearer Codex and Claude health signals.

- Recomputed usage-window reset countdowns from `resetAt` in the webview instead of trusting stale persisted `resetAfterSeconds` values.
- Changed provider reset tooltips from raw timestamps to relative labels such as `in 2h` or `soon` when the reset time is parseable.
- Changed old health-check timestamps from long hour counts to day-level labels, for example `1d ago`.
- Added a focused time-display validation script covering stale reset countdowns, reset formatting, and old relative timestamps.
- Added a Claude queue-pipeline validation script covering prompt construction, permission/profile argument mapping, queue sorting, output summaries, and live CLI executable invocation.
- Added npm script entries so the new validation scripts can be run as part of manual release checks.

## 0.0.3

Provider usage health preview for safer queue decisions.

- Added a compact, collapsible Provider Usage section to the sidebar.
- Added compact Provider Usage chips to the board header, including a one-click Update Health action.
- Made the full board editor webview explicit from the sidebar and command palette.
- Added an Open in window action from the board editor that asks VS Code to move the board into a separate editor window when supported.
- Added non-interactive Codex and Claude health checks from local CLI diagnostics when available.
- Added best-effort Codex rate-limit enrichment from recent local `codex.rate_limits` events, including used/remaining percentages and reset timing.
- Added defensive Claude usage parsing when local Claude CLI output includes percentage or reset details.
- Kept non-blocking Codex local diagnostics in tooltips without turning the provider usage signal into warning.
- Added Update Health to refresh provider usage health from the locally checkable clients.
- Added a Copilot usage web shortcut for manual quota review.
- Added provider usage badges with source, confidence, timestamp, and parsed quota details in hover tooltips.
- Added compact provider health chips to task cards.
- Added cached preflight checks before queueing or running Codex and Claude tasks when health data is missing or stale.
- Added queue warnings when a provider appears to be blocked by direct health checks or recent quota/token failures.
- Added Open Repository from task cards, preferring a nearby `.code-workspace` when one exists.
- Compactly restyled board and sidebar actions so queue, setup, health, and maintenance controls take less space.

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
