import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { AsyncQueue } from '../asyncQueue';
import { resolveCodexExecutable } from './executable';
import { buildCodexPrompt } from './prompt';

export class CodexCloudRunner implements AgentRunner {
  readonly id = 'codex-cloud';
  readonly displayName = 'Codex Cloud';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: true,
    writesFiles: false
  };

  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async validate(task: TaskSpec): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    const environmentId = config.get<string>('runners.codexCloud.environmentId', '');
    if (!environmentId.trim()) {
      errors.push('Codex Cloud environment ID is required. Set agenticKanbasutra.runners.codexCloud.environmentId.');
    }
    if (task.permissionProfile === 'read_only') {
      errors.push('Codex Cloud execution is not allowed with the read_only permission profile.');
    }
    return { valid: errors.length === 0, errors };
  }

  async start(task: TaskSpec, _context: RunnerContext): Promise<RunHandle> {
    const runId = randomUUID();
    const queue = new AsyncQueue<RunnerEvent>();
    void this.execute(runId, task, _context, queue);
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
      const environmentId = config.get<string>('runners.codexCloud.environmentId', '');
      const attempts = config.get<number>('runners.codexCloud.attempts', 1);
      const prompt = buildCodexPrompt(task);
      const args = [
        'cloud',
        'exec',
        '--env',
        environmentId,
        '--attempts',
        String(attempts)
      ];

      if (task.branchBase) {
        args.push('--branch', task.branchBase);
      }
      if (task.model.id && task.model.id !== 'provider-default') {
        args.push('-c', `model="${task.model.id}"`);
      }

      args.push(prompt);

      queue.push({
        type: 'progress',
        message: `Dispatching Codex Cloud task to environment ${environmentId}`,
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

      child.on('close', (exitCode) => {
        this.processes.delete(runId);
        if (spawnFailed) {
          return;
        }
        if (exitCode === 0) {
          queue.push({
            type: 'waiting_for_input',
            prompt: summarizeCloudDispatch(stdout, environmentId),
            at: new Date().toISOString()
          });
        } else {
          const message = `Codex Cloud dispatch failed with code ${exitCode}.\n\n${stderr || stdout || 'No Codex Cloud output was captured.'}`;
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
        error: { message, category: categorizeFailure(message), stack: error instanceof Error ? error.stack : undefined },
        at: new Date().toISOString()
      });
      queue.close();
    }
  }
}

function summarizeCloudDispatch(stdout: string, environmentId: string): string {
  return [
    'Codex Cloud task was dispatched successfully.',
    '',
    `Environment: ${environmentId}`,
    '',
    stdout.trim() || 'No task URL was printed.',
    '',
    'The remote Codex task is running outside VS Code. Review it in Codex Cloud or use Codex Cloud list/sync features when they are added to AgenticKanbasutra.'
  ].join('\n');
}
