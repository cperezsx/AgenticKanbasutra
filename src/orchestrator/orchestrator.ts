import * as path from 'path';
import * as vscode from 'vscode';
import { sortQueuedTasks } from '../domain/queue';
import { QueueExecutionMode, RunHandle, RunRecord, RunnerContext, RunnerEvent, TaskSpec } from '../domain/types';
import { validateTask } from '../domain/validation';
import { buildFailureSummary, categorizeFailure } from '../domain/resourceFailures';
import { GitService } from '../git/gitService';
import { RunnerRegistry } from '../runners/runnerRegistry';
import { TaskStore } from '../storage/taskStore';
import { buildTaskContextSection } from '../runners/contextPrompt';

export class Orchestrator {
  private readonly activeRuns = new Map<string, { taskId: string; runnerId: string }>();
  private readonly git = new GitService();
  private queuePaused = false;
  private queueDrainInProgress = false;
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly store: TaskStore,
    private readonly registry: RunnerRegistry,
    private readonly context: vscode.ExtensionContext
  ) {}

  isQueuePaused(): boolean {
    return this.queuePaused;
  }

  getQueueExecutionMode(): QueueExecutionMode {
    return vscode.workspace
      .getConfiguration('agenticKanbasutra')
      .get<QueueExecutionMode>('queue.executionMode', 'manual');
  }

  getQueueMaxConcurrent(): number {
    const configured = vscode.workspace.getConfiguration('agenticKanbasutra').get<number>('queue.maxConcurrent', 1);
    return Math.max(1, configured);
  }

  setQueuePaused(paused: boolean): void {
    this.queuePaused = paused;
    this.onDidChange.fire();
  }

  async enqueue(taskId: string): Promise<void> {
    const tasks = await this.store.getTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const validation = validateTask(task);
    if (!validation.valid) {
      throw new Error(validation.errors.join('\n'));
    }

    const queued = tasks.filter((item) => item.status === 'queued');
    task.status = 'queued';
    task.queuedAt = new Date().toISOString();
    task.queueRank = queued.length + 1;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.updatedAt = new Date().toISOString();
    await this.store.upsertTask(task);
    this.onDidChange.fire();
    await this.drainAutomaticQueue();
  }

  async runNext(): Promise<void> {
    await this.startNextQueuedTask();
  }

  async drainAutomaticQueue(): Promise<void> {
    if (this.queueDrainInProgress || this.queuePaused || this.getQueueExecutionMode() !== 'automatic') {
      return;
    }

    this.queueDrainInProgress = true;
    try {
      while (!this.queuePaused && this.getQueueExecutionMode() === 'automatic' && this.activeRuns.size < this.getQueueMaxConcurrent()) {
        const started = await this.startNextQueuedTask();
        if (!started) {
          break;
        }
      }
    } finally {
      this.queueDrainInProgress = false;
    }
  }

  private async startNextQueuedTask(): Promise<boolean> {
    if (this.queuePaused) {
      return false;
    }
    if (this.activeRuns.size >= this.getQueueMaxConcurrent()) {
      return false;
    }

    const queued = sortQueuedTasks((await this.store.getTasks()).filter((task) => task.status === 'queued'));
    const next = queued[0];
    if (!next) {
      return false;
    }
    await this.runTask(next.id);
    return true;
  }

  async runTask(taskId: string): Promise<void> {
    const tasks = await this.store.getTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const runner = this.registry.get(task.runner.id);
    if (!runner) {
      await this.failBeforeStart(task, `Runner ${task.runner.id} is not registered.`, 'configuration');
      return;
    }

    if (!vscode.workspace.isTrusted && runner.capabilities.writesFiles) {
      await this.failBeforeStart(task, 'Workspace Trust is required for write-capable runners.', 'permission_denied');
      return;
    }

    let runnerContext: RunnerContext;
    try {
      runnerContext = await this.createRunnerContext(task, runner.capabilities.writesFiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failBeforeStart(task, message, categorizeFailure(message));
      return;
    }

    const runnerValidation = await runner.validate(task, runnerContext);
    if (!runnerValidation.valid) {
      await this.failBeforeStart(task, runnerValidation.errors.join('\n'), categorizeFailure(runnerValidation.errors.join('\n')));
      return;
    }

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.completedAt = undefined;
    task.updatedAt = task.startedAt;
    await this.store.upsertTask(task);
    this.onDidChange.fire();

    let handle: RunHandle;
    try {
      handle = await runner.start(task, runnerContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failBeforeStart(task, message, categorizeFailure(message));
      return;
    }
    task.lastRunId = handle.runId;
    await this.store.upsertTask(task);
    this.activeRuns.set(handle.runId, { taskId: task.id, runnerId: runner.id });

    void this.consumeRunEvents(handle.runId, task, runner.id, handle.events, runnerContext);
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      return;
    }
    await this.registry.get(active.runnerId)?.cancel(runId);
  }

  private async consumeRunEvents(
    runId: string,
    task: TaskSpec,
    runnerId: string,
    events: AsyncIterable<RunnerEvent>,
    runnerContext: RunnerContext
  ): Promise<void> {
    let stdout = '';
    let stderr = '';
    let summary = '';
    const artifacts: RunRecord['artifacts'] = [];
    let exitCode: number | undefined;
    let status: TaskSpec['status'] = 'running';
    let errorMessage: string | undefined;

    const startedAt = task.startedAt ?? new Date().toISOString();
    const maxLogBytes = runnerContext.maxLogBytes;
    artifacts.push(await this.store.writeArtifact(runId, 'prompt', 'prompt.md', 'prompt.md', buildPromptArtifact(task)));

    try {
      for await (const event of events) {
        if (event.type === 'stdout') {
          stdout = appendLimited(stdout, event.chunk, maxLogBytes);
        }
        if (event.type === 'stderr') {
          stderr = appendLimited(stderr, event.chunk, maxLogBytes);
        }
        if (event.type === 'progress') {
          summary = event.message;
        }
        if (event.type === 'artifact') {
          artifacts.push(event.artifact);
        }
        if (event.type === 'waiting_for_input') {
          status = 'waiting_for_input';
          summary = event.prompt;
          await this.updateTaskStatus(task.id, status);
        }
        if (event.type === 'waiting_for_approval') {
          status = 'waiting_for_approval';
          summary = event.approval.message;
          await this.updateTaskStatus(task.id, status);
        }
        if (event.type === 'completed') {
          status = 'succeeded';
          exitCode = event.result.exitCode;
          summary = event.result.summary ?? summary;
        }
        if (event.type === 'failed') {
          status = 'failed';
          errorMessage = event.error.message;
          summary = buildFailureSummary(task.title, event.error);
        }
        if (event.type === 'cancelled') {
          status = 'cancelled';
          summary = event.reason ?? 'Run cancelled.';
        }
        this.onDidChange.fire();
      }
    } catch (error) {
      status = 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);
      summary = buildFailureSummary(task.title, {
        message: errorMessage,
        category: categorizeFailure(errorMessage),
        stack: error instanceof Error ? error.stack : undefined
      });
    }

    if (stdout) {
      artifacts.push(await this.store.writeArtifact(runId, 'stdout', 'stdout.log', 'stdout.log', stdout));
    }
    if (stderr) {
      artifacts.push(await this.store.writeArtifact(runId, 'stderr', 'stderr.log', 'stderr.log', stderr));
    }
    if (summary) {
      artifacts.push(await this.store.writeArtifact(runId, 'summary', 'summary.md', 'summary.md', summary));
    }

    const changedFiles = runnerContext.repositoryPath ? await this.git.getChangedFiles(runnerContext.repositoryPath) : [];
    const diff = runnerContext.repositoryPath ? await this.git.getDiff(runnerContext.repositoryPath) : '';
    if (diff) {
      artifacts.push(await this.store.writeArtifact(runId, 'diff', 'diff.patch', 'diff.patch', diff));
    }

    const completedAt = status === 'waiting_for_input' || status === 'waiting_for_approval' ? undefined : new Date().toISOString();
    const runRecord: RunRecord = {
      id: runId,
      taskId: task.id,
      runnerId,
      status,
      repository: task.repository,
      startedAt,
      completedAt,
      exitCode,
      summary,
      artifacts,
      changedFiles,
      branchBase: task.branchBase,
      worktreePath: runnerContext.worktreePath,
      worktreeBranch: runnerContext.worktreeBranch,
      error: errorMessage ? { message: errorMessage, category: categorizeFailure(errorMessage) } : undefined
    };
    await this.store.upsertRun(runRecord);

    const tasks = await this.store.getTasks();
    const storedTask = tasks.find((item) => item.id === task.id);
    if (storedTask) {
      storedTask.status = status;
      storedTask.updatedAt = new Date().toISOString();
      storedTask.completedAt = completedAt;
      storedTask.lastRunId = runId;
      await this.store.upsertTask(storedTask);
    }

    if (completedAt || status === 'waiting_for_input' || status === 'waiting_for_approval') {
      this.activeRuns.delete(runId);
    }
    this.onDidChange.fire();
    await this.drainAutomaticQueue();
  }

  private async updateTaskStatus(taskId: string, status: TaskSpec['status']): Promise<void> {
    const task = (await this.store.getTasks()).find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
    await this.store.upsertTask(task);
  }

  private async failBeforeStart(task: TaskSpec, message: string, category = categorizeFailure(message)): Promise<void> {
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const error = { message, category };
    const summary = buildFailureSummary(task.title, error);
    const artifact = await this.store.writeArtifact(runId, 'summary', 'summary.md', 'summary.md', summary);

    task.status = 'failed';
    task.startedAt = undefined;
    task.completedAt = now;
    task.updatedAt = now;
    task.lastRunId = runId;
    await this.store.upsertTask(task);
    await this.store.upsertRun({
      id: runId,
      taskId: task.id,
      runnerId: task.runner.id,
      status: 'failed',
      repository: task.repository,
      startedAt: now,
      completedAt: now,
      summary,
      artifacts: [artifact],
      changedFiles: [],
      branchBase: task.branchBase,
      error
    });
    this.onDidChange.fire();
    await this.drainAutomaticQueue();
  }

  private async createRunnerContext(task: TaskSpec, prepareLocalWorktree: boolean): Promise<RunnerContext> {
    const rootPath = this.context.globalStorageUri.fsPath;
    let repositoryPath = task.repository.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    let branchBase = task.branchBase;
    if (prepareLocalWorktree && repositoryPath && task.isolationMode === 'worktree') {
      const worktree = await this.git.prepareWorktree(repositoryPath, rootPath, task);
      worktreePath = worktree.path;
      worktreeBranch = worktree.branch;
      branchBase = worktree.baseRef;
      repositoryPath = worktree.path;
    }
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    return {
      extensionStoragePath: rootPath,
      artifactsPath: path.join(rootPath, 'artifacts'),
      repositoryPath,
      branchBase,
      worktreePath,
      worktreeBranch,
      maxLogBytes: config.get<number>('artifacts.maxLogBytes', 200000),
      commandTemplate: config.get<string>('runners.genericCli.commandTemplate')
    };
  }
}

function buildPromptArtifact(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    `Repository: ${task.repository.label}`,
    `Priority: ${task.priority}`,
    `Runner: ${task.runner.id}`,
    task.branchBase ? `Branch/base: ${task.branchBase}` : undefined,
    `Agent: ${task.agent.label}`,
    `Model: ${task.model.label}`,
    `Tools: ${task.toolsProfile.label}`,
    `Execution mode: ${task.executionMode}`,
    `Isolation mode: ${task.isolationMode}`,
    `Permission profile: ${task.permissionProfile}`,
    '',
    '## Spec',
    '',
    task.spec,
    buildTaskContextSection(task)
  ].flat().filter((line): line is string => line !== undefined).join('\n');
}

function appendLimited(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next) <= maxBytes) {
    return next;
  }
  const marker = '\n\n[AgenticKanbasutra truncated older log output]\n\n';
  const allowed = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let tail = next.slice(Math.max(0, next.length - allowed));
  while (Buffer.byteLength(tail) > allowed && tail.length > 0) {
    tail = tail.slice(1);
  }
  return `${marker}${tail}`;
}
