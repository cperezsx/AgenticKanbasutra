import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { categorizeFailure } from '../../domain/resourceFailures';
import { AgentRunner, RunHandle, RunnerContext, RunnerEvent, TaskSpec, ValidationResult } from '../../domain/types';
import { AsyncQueue } from '../asyncQueue';
import { buildCopilotPrompt } from './prompt';
import { resolveGitHubExecutable } from './executable';
import { resolveGitHubRepository } from './repository';

export class CopilotCloudRunner implements AgentRunner {
  readonly id = 'copilot-cloud';
  readonly displayName = 'GitHub Copilot Cloud';
  readonly capabilities = {
    canRunInBackground: true,
    canCancel: false,
    writesFiles: false
  };

  async validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.repositoryPath && !task.repository.remoteUrl) {
      errors.push('A GitHub repository path or remote URL is required for Copilot Cloud execution.');
    }
    if (task.permissionProfile === 'read_only') {
      errors.push('Copilot Cloud execution is not allowed with the read_only permission profile.');
    }
    return { valid: errors.length === 0, errors };
  }

  async start(task: TaskSpec, context: RunnerContext): Promise<RunHandle> {
    const runId = randomUUID();
    const queue = new AsyncQueue<RunnerEvent>();
    void this.execute(task, context, queue);
    return { runId, events: queue };
  }

  async cancel(): Promise<void> {
    return;
  }

  private async execute(task: TaskSpec, context: RunnerContext, queue: AsyncQueue<RunnerEvent>): Promise<void> {
    queue.push({ type: 'started', at: new Date().toISOString() });
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      const repo = await resolveGitHubRepository(context.repositoryPath, task.repository.remoteUrl);
      if (!repo) {
        throw new Error('Could not resolve a GitHub owner/repo from the selected repository.');
      }

      const body = JSON.stringify({
        prompt: buildCopilotPrompt(task),
        base_ref: task.branchBase || undefined,
        model: task.model.id && task.model.id !== 'provider-default' ? task.model.id : undefined,
        create_pull_request: vscode.workspace
          .getConfiguration('agenticKanbasutra')
          .get<boolean>('runners.copilotCloud.createPullRequest', false)
      });
      const config = vscode.workspace.getConfiguration('agenticKanbasutra');
      const ghExecutable = await resolveGitHubExecutable(config.get<string>('runners.github.executable', 'gh'));

      const args = [
        ...ghExecutable.argsPrefix,
        'api',
        '--method',
        'POST',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `/agents/repos/${repo.owner}/${repo.name}/tasks`,
        '--input',
        '-'
      ];

      queue.push({
        type: 'progress',
        message: `Dispatching Copilot Cloud task for ${repo.owner}/${repo.name}`,
        at: new Date().toISOString()
      });

      child = spawn(ghExecutable.command, args, {
        cwd: context.repositoryPath,
        shell: ghExecutable.shell,
        env: process.env
      });

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
      child.stdin.write(body);
      child.stdin.end();

      child.on('error', (error) => {
        spawnFailed = true;
        queue.push({
          type: 'failed',
          error: {
            message: [
              `Unable to start GitHub CLI executable: ${ghExecutable.resolvedPath}`,
              `Configured executable: ${ghExecutable.configuredExecutable}`,
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
        if (spawnFailed) {
          return;
        }
        if (exitCode === 0) {
          queue.push({
            type: 'waiting_for_input',
            prompt: summarizeCloudDispatch(stdout, repo),
            at: new Date().toISOString()
          });
        } else {
          const message = `Copilot Cloud dispatch failed with code ${exitCode}.\n\n${stderr || stdout || 'No gh output was captured.'}`;
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
      child?.kill();
    }
  }
}

function summarizeCloudDispatch(stdout: string, repo: { owner: string; name: string }): string {
  const json = tryParseJson(stdout);
  const id = json?.id ?? json?.task_id ?? json?.number ?? 'unknown';
  const url = json?.html_url ?? json?.url ?? `https://github.com/${repo.owner}/${repo.name}`;
  return [
    'Copilot Cloud task was dispatched successfully.',
    '',
    `Repository: ${repo.owner}/${repo.name}`,
    `Task ID: ${String(id)}`,
    `URL: ${String(url)}`,
    '',
    'The remote agent is now running outside VS Code. Review the task in GitHub or the Agents window, then attach the result or mark this task complete.'
  ].join('\n');
}

function tryParseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
