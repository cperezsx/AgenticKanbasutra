import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { AsyncQueue } from '../asyncQueue';
import { resolveCopilotExecutable } from './executable';
import { buildCopilotPrompt } from './prompt';

export class CopilotCliRunner implements AgentRunner {
  readonly id = 'copilot-cli';
  readonly displayName = 'GitHub Copilot CLI';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: true,
    writesFiles: true
  };

  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.repositoryPath) {
      errors.push('A local repository path is required for Copilot CLI execution.');
    }
    if (task.permissionProfile === 'ask') {
      errors.push('Copilot CLI non-interactive execution cannot use the ask permission profile. Use manual handoff, interactive Copilot, allow_workspace, or allow_worktree.');
    }
    if (task.permissionProfile === 'read_only' && needsGitMetadataWrites(task.spec)) {
      errors.push('Copilot CLI tasks that create branches, commits, or push to remotes cannot use the read_only permission profile.');
    }
    if (needsRemotePush(task.spec) && task.permissionProfile !== 'bypass' && deniesGitPush(this.permissionArgs(task))) {
      errors.push('Copilot CLI remote push tasks require the bypass permission profile or custom Copilot CLI permission args that allow git push.');
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
      const executable = await resolveCopilotExecutable(config.get<string>('runners.copilotCli.executable', 'copilot'));
      const runDir = path.join(context.artifactsPath, runId);
      await fs.mkdir(runDir, { recursive: true });

      const prompt = buildCopilotPrompt(task);
      const promptFile = path.join(runDir, 'copilot-prompt.md');
      const sessionFile = path.join(runDir, 'copilot-session.md');
      await fs.writeFile(promptFile, prompt, 'utf8');

      const args = [
        ...executable.argsPrefix,
        ...config.get<string[]>('runners.copilotCli.baseArgs', []),
        '-p',
        prompt,
        `--share=${sessionFile}`,
        '--add-dir',
        context.repositoryPath ?? ''
      ];

      if (task.model.id && task.model.id !== 'provider-default') {
        args.push('--model', task.model.id);
      }
      if (task.agent.id && !['default', 'default-agent'].includes(task.agent.id)) {
        args.push('--agent', task.agent.id);
      }

      args.push(...this.permissionArgs(task));

      queue.push({
        type: 'progress',
        message: `Starting Copilot CLI with prompt file ${promptFile}`,
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
              `Unable to start Copilot CLI executable: ${executable.resolvedPath}`,
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

      child.on('close', async (exitCode) => {
        this.processes.delete(runId);
        if (spawnFailed) {
          return;
        }
        try {
          await fs.access(sessionFile);
          queue.push({
            type: 'artifact',
            artifact: {
              id: randomUUID(),
              kind: 'summary',
              label: 'copilot-session.md',
              path: sessionFile
            },
            at: new Date().toISOString()
          });
        } catch {
          // Copilot CLI only writes the share file after a successful enough session.
        }

        if (exitCode === 0) {
          queue.push({
            type: 'completed',
            result: {
              exitCode: exitCode ?? undefined,
              summary: summarizeCopilotOutput(stdout)
            },
            at: new Date().toISOString()
          });
        } else {
          const message = [
            `Copilot CLI exited with code ${exitCode}.`,
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
    let args: string[];
    if (task.permissionProfile === 'read_only') {
      args = config.get<string[]>('runners.copilotCli.readOnlyArgs', []);
    } else if (task.permissionProfile === 'allow_worktree') {
      args = config.get<string[]>('runners.copilotCli.allowWorktreeArgs', []);
    } else if (task.permissionProfile === 'bypass') {
      args = config.get<string[]>('runners.copilotCli.bypassArgs', ['--allow-all']);
    } else {
      args = config.get<string[]>('runners.copilotCli.allowWorkspaceArgs', []);
    }
    return [...args, ...toolArgsFromProfile(task.toolsProfile.id)];
  }
}

function noOutputHint(exitCode: number | null, resolvedPath: string, configuredExecutable: string): string {
  if (typeof exitCode === 'number' && exitCode < 0) {
    return [
      'No Copilot CLI output was captured.',
      '',
      `Resolved executable: ${resolvedPath}`,
      `Configured executable: ${configuredExecutable}`,
      'Negative exit codes on Windows usually mean the process could not be started by VS Code. Set agenticKanbasutra.runners.copilotCli.executable to the full copilot.cmd path if this continues.'
    ].join('\n');
  }
  return 'No Copilot CLI output was captured.';
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

function needsRemotePush(spec: string): boolean {
  return [
    /\bpush\b/i,
    /\bremote\b/i,
    /\bsincroniz/i,
    /\bremoto\b/i
  ].some((pattern) => pattern.test(spec));
}

function deniesGitPush(args: string[]): boolean {
  return args.some((arg) => /deny-tool=.*git\s+push/i.test(arg));
}

function toolArgsFromProfile(profileId: string): string[] {
  const profile = profileId.trim();
  if (!profile || ['default-approvals', 'read-only', 'workspace-edit', 'none'].includes(profile)) {
    return [];
  }
  return profile
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      if (item.startsWith('--allow-tool=')) {
        return [item];
      }
      if (item.startsWith('allow-tool:')) {
        return [`--allow-tool=${item.slice('allow-tool:'.length).trim()}`];
      }
      if (item.startsWith('mcp:')) {
        return [`--allow-tool=${item.slice('mcp:'.length).trim()}`];
      }
      return [];
    });
}

function summarizeCopilotOutput(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-12).join('\n') || 'Copilot CLI completed successfully.';
}
