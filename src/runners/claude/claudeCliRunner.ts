import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { AsyncQueue } from '../asyncQueue';
import { resolveClaudeExecutable } from './executable';
import { buildClaudePrompt } from './prompt';

export class ClaudeCliRunner implements AgentRunner {
  readonly id = 'claude-cli';
  readonly displayName = 'Claude CLI';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: true,
    writesFiles: true
  };

  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.repositoryPath) {
      errors.push('A local repository path is required for Claude CLI execution.');
    }
    if (task.permissionProfile === 'ask') {
      errors.push('Claude CLI non-interactive execution cannot use the ask permission profile. Use manual handoff, read_only, allow_workspace, allow_worktree, or bypass.');
    }
    if (needsGitMetadataWrites(task.spec)) {
      if (task.permissionProfile === 'read_only') {
        errors.push('Claude CLI tasks that create branches, commits, or push to remotes cannot use the read_only permission profile.');
      } else if (task.permissionProfile !== 'bypass') {
        errors.push('Claude CLI tasks that create branches, commits, or push to remotes require the bypass permission profile.');
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async start(task: TaskSpec, context: RunnerContext): Promise<RunHandle> {
    const runId = randomUUID();
    const queue = new AsyncQueue<RunnerEvent>();
    void this.execute(runId, task, context, queue);
    return { runId, events: queue };
  }

  async cancel(runId: string): Promise<void> {
    const process = this.processes.get(runId);
    if (process) {
      process.kill();
      this.processes.delete(runId);
    }
  }

  private async execute(runId: string, task: TaskSpec, context: RunnerContext, queue: AsyncQueue<RunnerEvent>): Promise<void> {
    queue.push({ type: 'started', at: new Date().toISOString() });

    try {
      const config = vscode.workspace.getConfiguration('agenticKanbasutra');
      const executable = await resolveClaudeExecutable(config.get<string>('runners.claudeCli.executable', 'claude'));
      const runDir = path.join(context.artifactsPath, runId);
      await fs.mkdir(runDir, { recursive: true });

      const prompt = buildClaudePrompt(task);
      const promptFile = path.join(runDir, 'claude-prompt.md');
      await fs.writeFile(promptFile, prompt, 'utf8');

      const args = [
        ...executable.argsPrefix,
        ...config.get<string[]>('runners.claudeCli.baseArgs', []),
        '-p',
        prompt
      ];

      if (task.model.id && task.model.id !== 'provider-default') {
        args.push('--model', task.model.id);
      }

      args.push(...this.permissionArgs(task));
      args.push(...toolArgsFromProfile(task.toolsProfile.id));

      queue.push({
        type: 'progress',
        message: `Starting Claude CLI with prompt file ${promptFile}`,
        at: new Date().toISOString()
      });

      const child = spawn(executable.command, args, {
        cwd: context.repositoryPath,
        shell: executable.shell,
        env: process.env
      });
      child.stdin.end();
      this.processes.set(runId, child);

      let stdout = '';
      let stderr = '';
      let spawnFailed = false;

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        queue.push({ type: 'stdout', chunk: text, at: new Date().toISOString() });
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        queue.push({ type: 'stderr', chunk: text, at: new Date().toISOString() });
      });

      child.on('error', (error) => {
        spawnFailed = true;
        queue.push({
          type: 'failed',
          error: {
            message: [
              `Unable to start Claude CLI executable: ${executable.resolvedPath}`,
              `Configured executable: ${executable.configuredExecutable}`,
              '',
              error.message
            ].join('\n'),
            category: categorizeFailure(error.message),
            stack: error.stack
          },
          at: new Date().toISOString()
        });
        queue.close();
      });

      child.on('close', (exitCode) => {
        this.processes.delete(runId);
        if (spawnFailed) {
          return;
        }
        if (exitCode === 0) {
          queue.push({
            type: 'completed',
            result: {
              exitCode: exitCode ?? undefined,
              summary: summarizeClaudeOutput(stdout)
            },
            at: new Date().toISOString()
          });
        } else {
          const message = [
            `Claude CLI exited with code ${exitCode}.`,
            '',
            stderr || stdout || noOutputHint(exitCode, executable.resolvedPath, executable.configuredExecutable)
          ].join('\n');
          queue.push({
            type: 'failed',
            error: { message, category: categorizeFailure(message) },
            at: new Date().toISOString()
          });
        }
        queue.close();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({
        type: 'failed',
        error: {
          message,
          category: categorizeFailure(message),
          stack: error instanceof Error ? error.stack : undefined
        },
        at: new Date().toISOString()
      });
      queue.close();
    }
  }

  private permissionArgs(task: TaskSpec): string[] {
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    if (task.permissionProfile === 'read_only') {
      return config.get<string[]>('runners.claudeCli.readOnlyArgs', []);
    }
    if (task.permissionProfile === 'allow_worktree') {
      return config.get<string[]>('runners.claudeCli.allowWorktreeArgs', []);
    }
    if (task.permissionProfile === 'bypass') {
      return config.get<string[]>('runners.claudeCli.bypassArgs', ['--permission-mode', 'bypassPermissions']);
    }
    return config.get<string[]>('runners.claudeCli.allowWorkspaceArgs', []);
  }
}

function noOutputHint(exitCode: number | null, resolvedPath: string, configuredExecutable: string): string {
  if (typeof exitCode === 'number' && exitCode < 0) {
    return [
      'No Claude CLI output was captured.',
      '',
      `Resolved executable: ${resolvedPath}`,
      `Configured executable: ${configuredExecutable}`,
      'Negative exit codes on Windows usually mean the process could not be started by VS Code. Set agenticKanbasutra.runners.claudeCli.executable to the full claude.cmd path if this continues.'
    ].join('\n');
  }
  return 'No Claude CLI output was captured.';
}

function needsGitMetadataWrites(spec: string): boolean {
  return [
    /\bcommit\b/i,
    /\bcommits\b/i,
    /\bbranch\b/i,
    /\bpush\b/i,
    /\bremote\b/i,
    /\brama\b/i,
    /\bramas\b/i,
    /\bsincroniz/i,
    /\bremoto\b/i
  ].some((pattern) => pattern.test(spec));
}

function toolArgsFromProfile(profileId: string): string[] {
  const profile = profileId.trim();
  if (!profile || ['default-approvals', 'read-only', 'workspace-edit', 'none'].includes(profile)) {
    return [];
  }
  if (profile.startsWith('--tools=')) {
    return [profile];
  }
  if (profile.startsWith('tools:')) {
    return ['--tools', profile.slice('tools:'.length).trim()];
  }
  if (profile.startsWith('claude-tools:')) {
    return ['--tools', profile.slice('claude-tools:'.length).trim()];
  }
  return profile
    .split(/\s*;\s*/)
    .filter(Boolean)
    .flatMap((item) => toolArgsFromProfile(item));
}

function summarizeClaudeOutput(stdout: string): string {
  const parsed = parseClaudeJson(stdout);
  if (parsed) {
    return parsed;
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-12).join('\n') || 'Claude CLI completed successfully.';
}

function parseClaudeJson(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return firstString(value, ['result', 'text', 'response', 'summary']);
  } catch {
    return undefined;
  }
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}
