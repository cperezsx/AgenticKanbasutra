import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { AsyncQueue } from '../asyncQueue';
import { resolveCodexExecutable } from './executable';
import { buildCodexPrompt } from './prompt';

export class CodexCliRunner implements AgentRunner {
  readonly id = 'codex-cli';
  readonly displayName = 'Codex CLI';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: true,
    writesFiles: true
  };

  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.repositoryPath) {
      errors.push('A local repository path is required for Codex CLI execution.');
    }
    if (task.permissionProfile === 'ask') {
      errors.push('Codex CLI non-interactive execution cannot use the ask permission profile. Use codex-manual, read_only, allow_workspace, or allow_worktree.');
    }
    if (task.permissionProfile !== 'bypass' && needsGitMetadataWrites(task.spec)) {
      errors.push('Codex CLI tasks that create branches, commits, or push to remotes require the bypass permission profile because Codex workspace-write sandbox cannot modify .git metadata.');
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
      const configuredExecutable = config.get<string>('runners.codexCli.executable', 'codex');
      const executable = await resolveCodexExecutable(configuredExecutable);
      const runDir = path.join(context.artifactsPath, runId);
      await fs.mkdir(runDir, { recursive: true });

      const prompt = buildCodexPrompt(task);
      const promptFile = path.join(runDir, 'codex-prompt.md');
      const finalMessageFile = path.join(runDir, 'codex-final-message.md');
      await fs.writeFile(promptFile, prompt, 'utf8');

      const args = [
        ...config.get<string[]>('runners.codexCli.baseArgs', []),
        'exec',
        '--json',
        '--cd',
        context.repositoryPath ?? '',
        '--sandbox',
        sandboxFor(task),
        '--output-last-message',
        finalMessageFile
      ];

      if (task.model.id && task.model.id !== 'provider-default') {
        args.push('--model', task.model.id);
      }
      if (task.agent.id && !['default', 'default-agent'].includes(task.agent.id)) {
        args.push('--profile', task.agent.id);
      }

      args.push(prompt);

      queue.push({
        type: 'progress',
        message: `Starting Codex CLI with prompt file ${promptFile}`,
        at: new Date().toISOString()
      });

      const child = spawn(executable, args, {
        cwd: context.repositoryPath,
        shell: false,
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
              `Unable to start Codex CLI executable: ${executable}`,
              `Configured executable: ${configuredExecutable}`,
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
        const finalMessage = await readOptional(finalMessageFile);
        if (finalMessage) {
          queue.push({
            type: 'artifact',
            artifact: {
              id: randomUUID(),
              kind: 'summary',
              label: 'codex-final-message.md',
              path: finalMessageFile,
              byteLength: Buffer.byteLength(finalMessage)
            },
            at: new Date().toISOString()
          });
        }

        if (exitCode === 0) {
          queue.push({
            type: 'completed',
            result: {
              exitCode: exitCode ?? undefined,
              summary: finalMessage || summarizeCodexJsonl(stdout) || 'Codex CLI completed successfully.'
            },
            at: new Date().toISOString()
          });
        } else {
          const message = [
            `Codex CLI exited with code ${exitCode}.`,
            '',
            stderr || stdout || noOutputHint(exitCode, executable, configuredExecutable)
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
}

function noOutputHint(exitCode: number | null, executable: string, configuredExecutable: string): string {
  if (typeof exitCode === 'number' && exitCode < 0) {
    return [
      'No Codex CLI output was captured.',
      '',
      `Resolved executable: ${executable}`,
      `Configured executable: ${configuredExecutable}`,
      'Negative exit codes on Windows usually mean the process could not be started by VS Code. Set agenticKanbasutra.runners.codexCli.executable to the full codex.exe path if this continues.'
    ].join('\n');
  }
  return 'No Codex CLI output was captured.';
}

function sandboxFor(task: TaskSpec): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (task.permissionProfile === 'read_only') {
    return 'read-only';
  }
  if (task.permissionProfile === 'bypass') {
    return 'danger-full-access';
  }
  return 'workspace-write';
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

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function summarizeCodexJsonl(stdout: string): string | undefined {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.item?.type === 'agent_message' && event.item.text) {
        messages.push(event.item.text);
      }
    } catch {
      // Non-JSON progress output is still preserved as stdout artifact.
    }
  }
  return messages.at(-1);
}
