import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AsyncQueue } from '../asyncQueue';
import { buildTaskContextSection } from '../contextPrompt';

export class GenericCliRunner implements AgentRunner {
  readonly id = 'generic-cli';
  readonly displayName = 'Generic CLI';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: true,
    writesFiles: true
  };

  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.commandTemplate?.trim()) {
      errors.push('Generic CLI command template is required.');
    }
    if (!context.repositoryPath) {
      errors.push('A local repository path is required for generic CLI execution.');
    }
    if (task.permissionProfile === 'read_only') {
      errors.push('Generic CLI execution is not allowed with the read_only permission profile.');
    }
    return { valid: errors.length === 0, errors };
  }

  async start(task: TaskSpec, context: RunnerContext): Promise<RunHandle> {
    const runId = randomUUID();
    const queue = new AsyncQueue<RunnerEvent>();
    void this.execute(runId, task, context, queue);
    return {
      runId,
      events: queue
    };
  }

  async cancel(runId: string): Promise<void> {
    const process = this.processes.get(runId);
    if (process) {
      process.kill();
      this.processes.delete(runId);
    }
  }

  private async execute(runId: string, task: TaskSpec, context: RunnerContext, queue: AsyncQueue<RunnerEvent>): Promise<void> {
    const startedAt = new Date().toISOString();
    queue.push({ type: 'started', at: startedAt });

    try {
      const runDir = path.join(context.artifactsPath, runId);
      await fs.mkdir(runDir, { recursive: true });
      const promptFile = path.join(runDir, 'prompt.md');
      await fs.writeFile(promptFile, buildPrompt(task), 'utf8');
      queue.push({
        type: 'progress',
        message: `Prompt written to ${promptFile}`,
        at: new Date().toISOString()
      });

      const command = resolveCommandTemplate(context.commandTemplate ?? '', {
        promptFile,
        repositoryPath: context.repositoryPath ?? '',
        taskTitle: task.title
      });

      const child = spawn(command, {
        cwd: context.repositoryPath,
        shell: true,
        env: process.env
      });
      this.processes.set(runId, child);

      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTail = '';
      let stderrTail = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutBytes += Buffer.byteLength(text);
        stdoutTail = trimTail(`${stdoutTail}${text}`);
        if (stdoutBytes <= context.maxLogBytes) {
          queue.push({ type: 'stdout', chunk: text, at: new Date().toISOString() });
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrBytes += Buffer.byteLength(text);
        stderrTail = trimTail(`${stderrTail}${text}`);
        if (stderrBytes <= context.maxLogBytes) {
          queue.push({ type: 'stderr', chunk: text, at: new Date().toISOString() });
        }
      });

      child.on('error', (error) => {
        queue.push({
          type: 'failed',
          error: { message: error.message, category: categorizeFailure(error.message), stack: error.stack },
          at: new Date().toISOString()
        });
        queue.close();
      });

      child.on('close', (exitCode) => {
        this.processes.delete(runId);
        if (exitCode === 0) {
          queue.push({
            type: 'completed',
            result: {
              exitCode: exitCode ?? undefined,
              summary: `Generic CLI finished "${task.title}" with exit code ${exitCode}.`
            },
            at: new Date().toISOString()
          });
        } else {
          queue.push({
            type: 'failed',
            error: {
              message: `Generic CLI exited with code ${exitCode}.\n\n${stderrTail || stdoutTail || 'No process output was captured.'}`,
              category: categorizeFailure(`${stderrTail}\n${stdoutTail}\nexit code ${exitCode}`)
            },
            at: new Date().toISOString()
          });
        }
        queue.close();
      });
    } catch (error) {
      queue.push({
        type: 'failed',
        error: {
          message: error instanceof Error ? error.message : String(error),
          category: categorizeFailure(error instanceof Error ? error.message : String(error)),
          stack: error instanceof Error ? error.stack : undefined
        },
        at: new Date().toISOString()
      });
      queue.close();
    }
  }
}

function buildPrompt(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    `Repository: ${task.repository.label}`,
    `Priority: ${task.priority}`,
    task.branchBase ? `Branch/base: ${task.branchBase}` : undefined,
    `Agent: ${task.agent.label}`,
    `Model: ${task.model.label}`,
    `Tools: ${task.toolsProfile.label}`,
    `Execution mode: ${task.executionMode}`,
    `Isolation mode: ${task.isolationMode}`,
    `Permission profile: ${task.permissionProfile}`,
    '',
    '## Task spec',
    '',
    task.spec,
    buildTaskContextSection(task)
  ].flat().filter((line): line is string => line !== undefined).join('\n');
}

function resolveCommandTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => quoteForShell(values[key] ?? ''));
}

function quoteForShell(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function trimTail(value: string): string {
  return value.length <= 4000 ? value : value.slice(value.length - 4000);
}
