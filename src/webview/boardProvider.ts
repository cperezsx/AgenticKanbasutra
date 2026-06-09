import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { assignQueueRanks } from '../domain/queue';
import { BoardState, Priority, RepositoryDiscoveryInfo, RunnerConfigurationOption, TaskContextItem, TaskSpec } from '../domain/types';
import { isFinalStatus } from '../domain/validation';
import { getWebviewMessages } from '../config/localization';
import { GitService } from '../git/gitService';
import { Orchestrator } from '../orchestrator/orchestrator';
import { checkClaudeEnvironment } from '../runners/claude/claudeEnvironment';
import { checkCodexEnvironment } from '../runners/codex/codexEnvironment';
import { checkCopilotEnvironment } from '../runners/copilot/copilotEnvironment';
import { RunnerRegistry } from '../runners/runnerRegistry';
import { TaskStore } from '../storage/taskStore';

interface RunnerDiscovery {
  githubModels: RunnerConfigurationOption['models'];
  codexModels: RunnerConfigurationOption['models'];
  claudeModels: RunnerConfigurationOption['models'];
  githubAgents: RunnerConfigurationOption['agents'];
  codexAgents: RunnerConfigurationOption['agents'];
  claudeAgents: RunnerConfigurationOption['agents'];
  toolProfiles: RunnerConfigurationOption['toolsProfiles'];
}

const projectHintScanMaxDepth = 5;
const projectHintScanMaxDirectories = 350;
const contextFileScanMaxDepth = 12;
const contextFileScanMaxDirectories = 2000;
const contextFileScanMaxFiles = 10000;

export class BoardProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agenticKanbasutra.board';
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private panelReady = false;
  private readonly pendingPanelMessages: unknown[] = [];
  private readonly git = new GitService();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: TaskStore,
    private readonly orchestrator: Orchestrator,
    private readonly registry: RunnerRegistry
  ) {
    this.orchestrator.onDidChange.event(() => void this.postState());
    this.store.onDidChange.event(() => void this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, 'sidebar');
    webviewView.webview.onDidReceiveMessage((message) => void this.handleMessage(message, 'view'));
    void this.postState();
  }

  async revealNewTask(): Promise<void> {
    await this.openBoard(true);
  }

  async revealBoard(): Promise<void> {
    await this.openBoard(false);
  }

  async postState(): Promise<void> {
    await this.postToAll({ type: 'state', state: await this.createBoardState() });
  }

  private async handleMessage(message: { type: string; payload?: unknown }, source: 'view' | 'panel'): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          if ((message.payload as { mode?: string } | undefined)?.mode === 'panel') {
            this.panelReady = true;
            await this.flushPanelMessages();
          }
          await this.postState();
          break;
        case 'openBoard':
          await this.openBoard(false);
          break;
        case 'openNewTaskPanel':
          await this.openBoard(true);
          break;
        case 'openTaskPanel':
          await this.openBoard(false);
          await this.postToPanel({ type: 'selectTask', taskId: String(message.payload) });
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'agenticKanbasutra');
          break;
        case 'pickRepository':
          await this.pickRepository(source);
          break;
        case 'pickContextDiskFiles':
          await this.pickContextDiskFiles(message.payload as { repositoryPath?: string }, source);
          break;
        case 'pickContextRepositoryFiles':
          await this.pickContextRepositoryFiles(message.payload as { repositoryPath?: string }, source);
          break;
        case 'pickContextFolderFiles':
          await this.pickContextFolderFiles(message.payload as { repositoryPath?: string }, source);
          break;
        case 'pickContextFiles':
          await this.pickContextFiles(message.payload as { repositoryPath?: string }, source);
          break;
        case 'createTask':
          await this.createTask(message.payload as Partial<TaskSpec>);
          break;
        case 'updateTask':
          await this.updateTask(message.payload as Partial<TaskSpec>);
          break;
        case 'enqueueTask':
          await this.orchestrator.enqueue(String(message.payload));
          break;
        case 'moveTaskToPending':
          await this.moveTaskToPending(String(message.payload));
          break;
        case 'runTask':
          await this.orchestrator.runTask(String(message.payload));
          break;
        case 'cancelRun':
          await this.orchestrator.cancelRun(String(message.payload));
          break;
        case 'runNext':
          await this.orchestrator.runNext();
          break;
        case 'pauseQueue':
          this.orchestrator.setQueuePaused(true);
          break;
        case 'resumeQueue':
          this.orchestrator.setQueuePaused(false);
          await this.orchestrator.drainAutomaticQueue();
          break;
        case 'setQueueExecutionMode':
          await vscode.workspace
            .getConfiguration('agenticKanbasutra')
            .update('queue.executionMode', message.payload === 'automatic' ? 'automatic' : 'manual', vscode.ConfigurationTarget.Global);
          await this.orchestrator.drainAutomaticQueue();
          break;
        case 'deleteTask':
          await this.store.deleteTask(String(message.payload));
          await this.postState();
          break;
        case 'duplicateTask':
          await this.duplicateTask(String(message.payload));
          break;
        case 'reorderQueued':
          await this.reorderQueued(message.payload as string[]);
          break;
        case 'cleanupCompleted':
          await this.cleanupCompleted(true);
          break;
        case 'setCompletedVisible':
          await vscode.workspace
            .getConfiguration('agenticKanbasutra')
            .update('completed.visible', Boolean(message.payload), vscode.ConfigurationTarget.Global);
          await this.postState();
          break;
        case 'openArtifact':
          await this.openArtifact(String(message.payload));
          break;
        case 'openChangedFile':
          await this.openChangedFile(message.payload as { rootPath?: string; relativePath?: string });
          break;
        case 'revealPath':
          await this.revealPath(String(message.payload));
          break;
        case 'checkCopilot':
          await this.checkCopilot();
          break;
        case 'checkCodex':
          await this.checkCodex();
          break;
        case 'checkClaude':
          await this.checkClaude();
          break;
        case 'completeManualTask':
          await this.completeManualTask(message.payload as { taskId: string; summary: string });
          break;
      }
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      await this.postState();
    }
  }

  private async openBoard(openNewTask: boolean): Promise<void> {
    if (!this.panel) {
      this.panelReady = false;
      this.panel = vscode.window.createWebviewPanel(
        'agenticKanbasutra.boardPanel',
        'AgenticKanbasutra',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        }
      );
      this.panel.webview.html = this.getHtml(this.panel.webview, 'panel');
      this.panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message, 'panel'));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.panelReady = false;
        this.pendingPanelMessages.length = 0;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }

    await this.postState();
    if (openNewTask) {
      await this.postToPanel({ type: 'openNewTask' });
    }
  }

  private async createTask(input: Partial<TaskSpec>): Promise<void> {
    const repository = input.repository ?? this.defaultRepository();
    await this.assertValidLocalRepository(repository);
    const now = new Date().toISOString();
    const task: TaskSpec = {
      id: randomUUID(),
      title: String(input.title ?? '').trim(),
      spec: String(input.spec ?? '').trim(),
      repository,
      runner: input.runner ?? { id: 'copilot-cli' },
      agent: input.agent ?? { id: 'default', label: 'Default agent' },
      model: input.model ?? { id: 'provider-default', label: 'Provider default' },
      toolsProfile: input.toolsProfile ?? { id: 'default-approvals', label: 'Default Approvals' },
      executionMode: input.executionMode ?? 'foreground',
      isolationMode: input.isolationMode ?? 'workspace',
      permissionProfile: input.permissionProfile ?? 'allow_workspace',
      status: 'pending',
      priority: (input.priority as Priority | undefined) ?? 'normal',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      branchBase: normalizeOptionalString(input.branchBase),
      notes: normalizeOptionalString(input.notes),
      contextItems: normalizeContextItems(input.contextItems)
    };
    await this.store.upsertTask(task);
    await this.postState();
  }

  private async updateTask(input: Partial<TaskSpec>): Promise<void> {
    if (!input.id) {
      return;
    }
    const task = (await this.store.getTasks()).find((item) => item.id === input.id);
    if (!task) {
      return;
    }
    const nextTask = {
      ...task,
      ...input,
      updatedAt: new Date().toISOString()
    } as TaskSpec;
    await this.assertValidLocalRepository(nextTask.repository);
    nextTask.branchBase = normalizeOptionalString(input.branchBase ?? nextTask.branchBase);
    nextTask.notes = normalizeOptionalString(input.notes ?? nextTask.notes);
    nextTask.contextItems = normalizeContextItems(input.contextItems ?? nextTask.contextItems);
    await this.store.upsertTask(nextTask);
    await this.postState();
  }

  private async pickRepository(source: 'view' | 'panel'): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use Git Repository',
      title: 'Select a Git repository folder'
    });
    const uri = selection?.[0];
    if (!uri) {
      await this.postToSource(source, { type: 'repositoryPickCancelled' });
      return;
    }
    if (!(await this.git.isGitRepository(uri.fsPath))) {
      await vscode.window.showWarningMessage(`Selected folder is not a valid Git repository: ${uri.fsPath}`);
      await this.postToSource(source, {
        type: 'repositoryValidation',
        payload: { ok: false, path: uri.fsPath, message: 'Selected folder is not a valid Git repository.' }
      });
      return;
    }

    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    const runnerConfiguration = await this.createRunnerConfiguration(config, [uri.fsPath]);
    await this.postToSource(source, {
      type: 'repositoryPicked',
      payload: {
        repository: {
          type: 'localPath',
          label: path.basename(uri.fsPath) || uri.fsPath,
          path: uri.fsPath
        },
        branches: await this.git.getBranches(uri.fsPath),
        runnerOptions: runnerConfiguration.runnerOptions,
        repositoryDiscovery: runnerConfiguration.discoveryInfo
      }
    });
  }

  private async pickContextFiles(payload: { repositoryPath?: string }, source: 'view' | 'panel'): Promise<void> {
    await this.pickContextDiskFiles(payload, source);
  }

  private async pickContextDiskFiles(payload: { repositoryPath?: string }, source: 'view' | 'panel'): Promise<void> {
    const files = await this.pickContextDiskFilePaths(payload?.repositoryPath);
    await this.postPickedContextFiles(source, files);
  }

  private async pickContextRepositoryFiles(payload: { repositoryPath?: string }, source: 'view' | 'panel'): Promise<void> {
    const repositoryPath = payload?.repositoryPath;
    if (!repositoryPath) {
      await vscode.window.showWarningMessage('Select a repository before searching repository files.');
      await this.postToSource(source, { type: 'contextPickCancelled' });
      return;
    }
    const items = await this.pickContextFilesFromRepository(repositoryPath);
    if (!items?.length) {
      await this.postToSource(source, { type: 'contextPickCancelled' });
      return;
    }
    await this.postToSource(source, { type: 'contextFilesPicked', payload: items });
  }

  private async pickContextFolderFiles(payload: { repositoryPath?: string }, source: 'view' | 'panel'): Promise<void> {
    const folders = await this.pickContextFolders(payload?.repositoryPath);
    if (!folders?.length) {
      await this.postToSource(source, { type: 'contextPickCancelled' });
      return;
    }
    const files = await this.pickFilesInsideDirectories(folders);
    await this.postPickedContextFiles(source, files);
  }

  private async postPickedContextFiles(source: 'view' | 'panel', files: string[] | undefined): Promise<void> {
    if (!files?.length) {
      await this.postToSource(source, { type: 'contextPickCancelled' });
      return;
    }
    await this.postToSource(source, { type: 'contextFilesPicked', payload: this.contextItemsFromPaths(files) });
  }

  private async pickContextFilesFromRepository(repositoryPath: string): Promise<TaskContextItem[] | undefined> {
    const files = await listContextFiles(repositoryPath);
    if (!files.length) {
      await vscode.window.showWarningMessage('No files were found in the selected repository search scope.');
      return [];
    }

    const picked = await vscode.window.showQuickPick([
      ...files.map((filePath) => {
        const relativePath = path.relative(repositoryPath, filePath);
        return {
          label: `$(file) ${path.basename(filePath)}`,
          description: path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
          detail: relativePath,
          filePath
        };
      })
    ], {
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Search repository files to attach as task context',
      title: `Attach context files from ${path.basename(repositoryPath) || repositoryPath}`
    });

    if (!picked) {
      return undefined;
    }
    const selectedFiles = picked
      .filter((item): item is typeof item & { filePath: string } => Boolean((item as { filePath?: string }).filePath))
      .map((item) => item.filePath);

    if (selectedFiles.length > 0) {
      return selectedFiles.map((filePath) => ({
        id: randomUUID(),
        kind: 'file',
        label: path.basename(filePath) || filePath,
        path: filePath,
        description: ''
      }));
    }

    return undefined;
  }

  private async pickContextDiskFilePaths(repositoryPath?: string): Promise<string[] | undefined> {
    const defaultUri = repositoryPath ? vscode.Uri.file(repositoryPath) : undefined;
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri,
      filters: {
        'All files': ['*'],
        'Markdown': ['md', 'mdx', 'markdown'],
        'Web': ['html', 'htm', 'css', 'js', 'ts', 'json'],
        'PDF': ['pdf']
      },
      openLabel: 'Attach Files',
      title: 'Attach context files'
    });
    if (!selection?.length) {
      return undefined;
    }
    return selection.map((uri) => uri.fsPath);
  }

  private async pickContextFolders(repositoryPath?: string): Promise<string[] | undefined> {
    const defaultUri = repositoryPath ? vscode.Uri.file(repositoryPath) : undefined;
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri,
      openLabel: 'Search Folder',
      title: 'Choose folders to search for context files'
    });
    if (!selection?.length) {
      return undefined;
    }
    return selection.map((uri) => uri.fsPath);
  }

  private contextItemsFromPaths(paths: string[]): TaskContextItem[] {
    return paths.map((filePath) => ({
      id: randomUUID(),
      kind: 'file',
      label: path.basename(filePath) || filePath,
      path: filePath,
      description: ''
    }));
  }

  private async pickFilesInsideDirectories(directoryPaths: string[]): Promise<string[] | undefined> {
    const files = dedupeStrings((await Promise.all(directoryPaths.map((directoryPath) => listContextFiles(directoryPath)))).flat());
    if (!files.length) {
      await vscode.window.showWarningMessage('No attachable files were found inside the selected folder.');
      return [];
    }
    const picked = await vscode.window.showQuickPick(files.map((filePath) => {
      const root = directoryPaths.find((directoryPath) => isPathInside(directoryPath, filePath)) ?? path.dirname(filePath);
      const relativePath = path.relative(root, filePath);
      return {
        label: `$(file) ${path.basename(filePath)}`,
        description: path.dirname(relativePath) === '.' ? path.basename(root) : path.join(path.basename(root), path.dirname(relativePath)),
        detail: filePath,
        filePath
      };
    }), {
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Search files inside the selected folder',
      title: 'Attach files from selected folder'
    });
    if (!picked) {
      return undefined;
    }
    return picked.map((item) => item.filePath);
  }

  private async duplicateTask(taskId: string): Promise<void> {
    const source = (await this.store.getTasks()).find((task) => task.id === taskId);
    if (!source) {
      return;
    }
    const now = new Date().toISOString();
    await this.store.upsertTask({
      ...source,
      id: randomUUID(),
      title: `${source.title} copy`,
      status: 'pending',
      queueRank: undefined,
      queuedAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      lastRunId: undefined,
      createdAt: now,
      updatedAt: now
    });
    await this.postState();
  }

  private async completeManualTask(payload: { taskId: string; summary: string }): Promise<void> {
    const task = (await this.store.getTasks()).find((item) => item.id === payload.taskId);
    if (!task) {
      return;
    }
    const now = new Date().toISOString();
    task.status = 'succeeded';
    task.completedAt = now;
    task.updatedAt = now;

    const runId = task.lastRunId ?? randomUUID();
    const summary = payload.summary?.trim() || 'Manual result completed.';
    const artifact = await this.store.writeArtifact(runId, 'summary', 'manual-summary.md', 'manual-summary.md', summary);
    const existingRun = (await this.store.getRuns()).find((run) => run.id === runId);
    await this.store.upsertRun({
      id: runId,
      taskId: task.id,
      runnerId: task.runner.id,
      status: 'succeeded',
      repository: task.repository,
      startedAt: task.startedAt ?? now,
      completedAt: now,
      summary,
      artifacts: [...(existingRun?.artifacts ?? []), artifact],
      changedFiles: existingRun?.changedFiles ?? []
    });
    task.lastRunId = runId;
    await this.store.upsertTask(task);
    await this.postState();
    await this.orchestrator.drainAutomaticQueue();
  }

  private async moveTaskToPending(taskId: string): Promise<void> {
    const task = (await this.store.getTasks()).find((item) => item.id === taskId);
    if (!task || !['queued', 'failed'].includes(task.status)) {
      return;
    }
    task.status = 'pending';
    task.queueRank = undefined;
    task.queuedAt = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.updatedAt = new Date().toISOString();
    await this.store.upsertTask(task);
    await this.postState();
  }

  private async reorderQueued(ids: string[]): Promise<void> {
    const tasks = await this.store.getTasks();
    const queuedById = new Map(tasks.filter((task) => task.status === 'queued').map((task) => [task.id, task]));
    const reordered = assignQueueRanks(ids.map((id) => queuedById.get(id)).filter((task): task is TaskSpec => Boolean(task)));
    await this.store.upsertTasks(reordered);
    await this.postState();
  }

  async cleanupCompleted(forceDeleteAll = false): Promise<void> {
    if (forceDeleteAll) {
      const tasks = await this.store.getTasks();
      await Promise.all(tasks.filter((task) => isFinalStatus(task.status)).map((task) => this.store.deleteTask(task.id)));
      await this.postState();
      return;
    }

    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    if (config.get<boolean>('completed.autoDelete.enabled', false)) {
      await this.store.cleanupCompleted(
        config.get<number>('completed.autoDelete.afterDays', 14),
        config.get<boolean>('completed.keepFailed', true)
      );
    }
    await this.postState();
  }

  async checkCopilot(): Promise<void> {
    const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const report = await checkCopilotEnvironment(repositoryPath);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: report.markdown
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async checkCodex(): Promise<void> {
    const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const report = await checkCodexEnvironment(repositoryPath);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: report.markdown
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async checkClaude(): Promise<void> {
    const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const report = await checkClaudeEnvironment(repositoryPath);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: report.markdown
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async openArtifact(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    try {
      await fs.access(uri.fsPath);
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      await vscode.window.showWarningMessage(`Artifact not found: ${filePath}`);
    }
  }

  private async openChangedFile(payload: { rootPath?: string; relativePath?: string }): Promise<void> {
    const rootPath = payload.rootPath;
    const relativePath = payload.relativePath;
    if (!rootPath || !relativePath) {
      await vscode.window.showWarningMessage('Changed file path is incomplete.');
      return;
    }

    const uri = vscode.Uri.file(path.resolve(rootPath, relativePath));
    try {
      await fs.access(uri.fsPath);
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      await vscode.window.showWarningMessage(`Changed file not found: ${relativePath}`);
    }
  }

  private async revealPath(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }

    const uri = vscode.Uri.file(filePath);
    try {
      await fs.access(uri.fsPath);
      await vscode.commands.executeCommand('revealFileInOS', uri);
    } catch {
      await vscode.window.showWarningMessage(`Path not found: ${filePath}`);
    }
  }

  private async createBoardState(): Promise<BoardState> {
    const locale = vscode.env.language || 'en';
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    const tasks = await this.store.getTasks();
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      label: folder.name,
      path: folder.uri.fsPath
    }));
    const knownRepositoryPaths = [
      ...workspaceFolders.map((folder) => folder.path),
      ...tasks.map((task) => task.repository?.path).filter((value): value is string => Boolean(value))
    ];
    const workspaceBranches = workspaceFolders[0]?.path ? await this.git.getBranches(workspaceFolders[0].path) : [];
    const repositoryBranches = await this.getRepositoryBranches(knownRepositoryPaths);
    const runnerConfiguration = await this.createRunnerConfiguration(config, knownRepositoryPaths);

    return {
      tasks,
      runs: await this.store.getRuns(),
      completedVisible: config.get<boolean>('completed.visible', true),
      queuePaused: this.orchestrator.isQueuePaused(),
      queueExecutionMode: this.orchestrator.getQueueExecutionMode(),
      queueMaxConcurrent: this.orchestrator.getQueueMaxConcurrent(),
      locale,
      messages: getWebviewMessages(locale),
      workspaceFolders,
      workspaceBranches,
      runners: this.registry.all().map((runner) => ({
        id: runner.id,
        label: runner.displayName
      })),
      runnerOptions: runnerConfiguration.runnerOptions,
      repositoryBranches,
      repositoryDiscovery: runnerConfiguration.discoveryInfo
    };
  }

  private async createRunnerOptions(config: vscode.WorkspaceConfiguration, repositoryPaths: string[]): Promise<RunnerConfigurationOption[]> {
    return (await this.createRunnerConfiguration(config, repositoryPaths)).runnerOptions;
  }

  private async createRunnerConfiguration(
    config: vscode.WorkspaceConfiguration,
    repositoryPaths: string[]
  ): Promise<{ runnerOptions: RunnerConfigurationOption[]; discoveryInfo: RepositoryDiscoveryInfo }> {
    const discoveryPaths = await this.repositoryDiscoveryPaths(repositoryPaths);
    const discovery = await this.discoverRunnerOptions(config, discoveryPaths);
    const runnerOptions = this.registry.all().map((runner) => runnerConfigurationFor(
        runner.id,
        runner.displayName,
        config.get<string>('runners.github.defaultModel', 'auto'),
        config.get<string>('runners.codex.defaultModel', 'auto'),
        config.get<string>('runners.claude.defaultModel', 'auto'),
        discovery
      ));
    return {
      runnerOptions,
      discoveryInfo: {
        repositoryPaths: discoveryPaths,
        githubAgents: discovery.githubAgents.length,
        codexAgents: discovery.codexAgents.length,
        toolsProfiles: discovery.toolProfiles.length
      }
    };
  }

  private async repositoryDiscoveryPaths(repositoryPaths: string[]): Promise<string[]> {
    const roots = await Promise.all(repositoryPaths.filter(Boolean).map((repositoryPath) => this.git.getRoot(repositoryPath)));
    return dedupeStrings([...repositoryPaths, ...roots.filter((value): value is string => Boolean(value))]);
  }

  private async discoverRunnerOptions(config: vscode.WorkspaceConfiguration, workspacePaths: string[]): Promise<RunnerDiscovery> {
    const configuredTools = optionsFromSettings(config.get<string[]>('runners.toolsProfileOptions', []), 'Configured tool profile');
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const [projectHints, codexHints] = await Promise.all([
      discoverProjectHints(workspacePaths),
      discoverCodexHints(codexHome)
    ]);

    return {
      githubModels: optionsFromSettings(config.get<string[]>('runners.github.modelOptions', []), 'Configured GitHub Copilot model'),
      codexModels: optionsFromSettings(config.get<string[]>('runners.codex.modelOptions', []), 'Configured Codex model'),
      claudeModels: optionsFromSettings(config.get<string[]>('runners.claude.modelOptions', []), 'Configured Claude model'),
      githubAgents: [
        ...optionsFromSettings(config.get<string[]>('runners.github.agentOptions', []), 'Configured GitHub Copilot agent'),
        ...projectHints.githubAgents
      ],
      codexAgents: [
        ...optionsFromSettings(config.get<string[]>('runners.codex.profileOptions', []), 'Configured Codex profile'),
        ...codexHints.codexProfiles
      ],
      claudeAgents: optionsFromSettings(config.get<string[]>('runners.claude.profileOptions', []), 'Configured Claude profile'),
      toolProfiles: dedupeOptions([
        ...configuredTools,
        ...projectHints.toolProfiles,
        ...codexHints.toolProfiles
      ])
    };
  }

  private async getRepositoryBranches(paths: string[]): Promise<BoardState['repositoryBranches']> {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    const entries = await Promise.all(uniquePaths.map(async (repositoryPath) => {
      if (!(await this.git.isGitRepository(repositoryPath))) {
        return [repositoryPath, []] as const;
      }
      return [repositoryPath, await this.git.getBranches(repositoryPath)] as const;
    }));
    return Object.fromEntries(entries);
  }

  private async assertValidLocalRepository(repository: Partial<TaskSpec>['repository']): Promise<void> {
    if (!repository?.path) {
      throw new Error('Select a local Git repository before saving the task.');
    }
    if (!(await this.git.isGitRepository(repository.path))) {
      throw new Error(`Repository path is not a valid Git repository: ${repository.path}`);
    }
  }

  private defaultRepository() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      type: 'workspace' as const,
      label: folder?.name ?? 'Current workspace',
      path: folder?.uri.fsPath
    };
  }

  private async postToAll(message: unknown): Promise<void> {
    await this.view?.webview.postMessage(message);
    await this.postToPanel(message);
  }

  private async postToPanel(message: unknown): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (!this.panelReady) {
      this.pendingPanelMessages.push(message);
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private async postToSource(source: 'view' | 'panel', message: unknown): Promise<void> {
    if (source === 'panel') {
      await this.postToPanel(message);
      return;
    }
    await this.view?.webview.postMessage(message);
  }

  private async flushPanelMessages(): Promise<void> {
    while (this.panel && this.pendingPanelMessages.length > 0) {
      const message = this.pendingPanelMessages.shift();
      await this.panel.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview, mode: 'sidebar' | 'panel'): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'styles.css'));
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>AgenticKanbasutra</title>
</head>
<body>
  <div id="app" class="app app-${mode}" data-mode="${mode}">
    <div class="boot">
      <img src="${iconUri}" alt="" />
      <span>Booting AgenticKanbasutra...</span>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : undefined;
}

function normalizeContextItems(value: unknown): TaskContextItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): TaskContextItem | undefined => {
      const input = item as Partial<TaskContextItem>;
      const label = normalizeOptionalString(input.label);
      const filePath = normalizeOptionalString(input.path);
      const content = normalizeOptionalString(input.content);
      if (!label && !filePath && !content) {
        return undefined;
      }
      return {
        id: normalizeOptionalString(input.id) ?? randomUUID(),
        kind: input.kind === 'folder' || input.kind === 'note' ? input.kind : 'file',
        label: label ?? filePath ?? 'Context',
        path: filePath,
        content,
        description: normalizeOptionalString(input.description)
      };
    })
    .filter((item): item is TaskContextItem => Boolean(item));
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverProjectHints(workspacePaths: string[]): Promise<Pick<RunnerDiscovery, 'githubAgents' | 'toolProfiles'>> {
  const githubAgents: RunnerConfigurationOption['agents'] = [];
  const toolProfiles: RunnerConfigurationOption['toolsProfiles'] = [];

  for (const workspacePath of [...new Set(workspacePaths.filter(Boolean))]) {
    for (const hintRoot of await projectHintRoots(workspacePath)) {
      const githubPath = path.join(hintRoot, '.github');
      const agentsPath = path.join(githubPath, 'agents');
      for (const filePath of await listFilesRecursive(agentsPath, ['.md', '.mdx'], 4)) {
        if (!isAgentFile(filePath)) {
          continue;
        }
        const metadata = await markdownFrontmatter(filePath);
        const fileId = agentIdFromFile(filePath);
        const label = metadata.name || titleFromSlug(fileId);
        githubAgents.push({
          id: label,
          label,
          description: [metadata.description, relativeHint(workspacePath, filePath)].filter(Boolean).join(' / ')
        });
      }

      const chatmodesPath = path.join(githubPath, 'chatmodes');
      for (const filePath of await listFilesRecursive(chatmodesPath, ['.md', '.mdx'], 4)) {
        const metadata = await markdownFrontmatter(filePath);
        const id = chatmodeIdFromFile(filePath);
        githubAgents.push({
          id,
          label: metadata.name || `${titleFromSlug(id)} chatmode`,
          description: [metadata.description, relativeHint(workspacePath, filePath)].filter(Boolean).join(' / ')
        });
      }

      for (const filePath of [
        path.join(githubPath, 'mcp.json'),
        path.join(hintRoot, '.vscode', 'mcp.json')
      ]) {
        for (const server of await mcpServerNamesFromJson(filePath)) {
          toolProfiles.push({
            id: `mcp:${server}`,
            label: `MCP ${server}`,
            description: relativeHint(workspacePath, filePath)
          });
        }
      }
    }
  }

  return {
    githubAgents: dedupeOptions(githubAgents),
    toolProfiles: dedupeOptions(toolProfiles)
  };
}

async function projectHintRoots(repositoryPath: string): Promise<string[]> {
  const roots = new Set<string>([repositoryPath]);
  let visited = 0;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (visited >= projectHintScanMaxDirectories || depth > projectHintScanMaxDepth) {
      return;
    }
    visited += 1;

    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isDirectory() && entry.name === '.github')) {
      roots.add(directoryPath);
    }
    if (depth >= projectHintScanMaxDepth) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipProjectHintDirectory(entry.name)) {
        continue;
      }
      await visit(path.join(directoryPath, entry.name), depth + 1);
    }
  }

  await visit(repositoryPath, 0);
  return [...roots];
}

function shouldSkipProjectHintDirectory(name: string): boolean {
  return new Set([
    '.git',
    '.hg',
    '.svn',
    '.vscode',
    'node_modules',
    'dist',
    'out',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    'target',
    'vendor'
  ]).has(name);
}

function chatmodeIdFromFile(filePath: string): string {
  return slug(path.basename(filePath).replace(/(\.chatmode)?\.(md|mdx)$/i, ''));
}

function agentIdFromFile(filePath: string): string {
  return slug(path.basename(filePath).replace(/(\.agent)?\.(md|mdx)$/i, ''));
}

function isAgentFile(filePath: string): boolean {
  return /\.agent\.(md|mdx)$/i.test(path.basename(filePath));
}

async function markdownFrontmatter(filePath: string): Promise<{ name?: string; description?: string }> {
  const text = await readOptionalText(filePath);
  if (!text?.startsWith('---')) {
    return {};
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    return {};
  }
  const metadata: { name?: string; description?: string } = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^\s*(name|description)\s*:\s*(.+?)\s*$/i);
    if (!match) {
      continue;
    }
    metadata[match[1].toLowerCase() as 'name' | 'description'] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return metadata;
}

async function listContextFiles(repositoryPath: string): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (
      visited >= contextFileScanMaxDirectories ||
      files.length >= contextFileScanMaxFiles ||
      depth > contextFileScanMaxDepth
    ) {
      return;
    }
    visited += 1;

    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= contextFileScanMaxFiles) {
        return;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isFile()) {
        files.push(entryPath);
        continue;
      }
      if (!entry.isDirectory() || depth >= contextFileScanMaxDepth || shouldSkipContextFileDirectory(entry.name)) {
        continue;
      }
      await visit(entryPath, depth + 1);
    }
  }

  await visit(repositoryPath, 0);
  return files.sort((left, right) => path.relative(repositoryPath, left).localeCompare(path.relative(repositoryPath, right)));
}

function shouldSkipContextFileDirectory(name: string): boolean {
  return new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'dist',
    'out',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    'target',
    'vendor',
    '.venv',
    'venv',
    '__pycache__'
  ]).has(name);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function discoverCodexHints(codexHome: string): Promise<{
  codexProfiles: RunnerConfigurationOption['agents'];
  toolProfiles: RunnerConfigurationOption['toolsProfiles'];
}> {
  const configPath = path.join(codexHome, 'config.toml');
  const text = await readOptionalText(configPath);
  if (!text) {
    return { codexProfiles: [], toolProfiles: [] };
  }

  const codexProfiles = sectionNames(text, /^profiles\.([A-Za-z0-9_.-]+)$/).map((profile) => ({
    id: profile,
    label: `${titleFromSlug(profile)} profile`,
    description: `Discovered from ${configPath}`
  }));

  const toolProfiles = sectionNames(text, /^mcp_servers\.([A-Za-z0-9_.-]+)$/).map((server) => ({
    id: `mcp:${server}`,
    label: `MCP ${server}`,
    description: `Discovered from ${configPath}`
  }));

  return {
    codexProfiles: dedupeOptions(codexProfiles),
    toolProfiles: dedupeOptions(toolProfiles)
  };
}

async function listFiles(directoryPath: string, extensions: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(directoryPath, entry.name));
  } catch {
    return [];
  }
}

async function listFilesRecursive(directoryPath: string, extensions: string[], maxDepth: number): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentPath: string, depth: number): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        files.push(entryPath);
        continue;
      }
      if (entry.isDirectory() && depth < maxDepth && !shouldSkipProjectHintDirectory(entry.name)) {
        await visit(entryPath, depth + 1);
      }
    }
  }

  await visit(directoryPath, 0);
  return files.sort();
}

async function mcpServerNamesFromJson(filePath: string): Promise<string[]> {
  const text = await readOptionalText(filePath);
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.servers ?? parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function sectionNames(tomlText: string, pattern: RegExp): string[] {
  const names: string[] = [];
  for (const line of tomlText.split(/\r?\n/)) {
    const match = line.trim().match(/^\[([^\]]+)]$/);
    if (!match) {
      continue;
    }
    const sectionMatch = match[1].match(pattern);
    if (sectionMatch?.[1]) {
      names.push(sectionMatch[1]);
    }
  }
  return names;
}

function optionsFromSettings(values: string[], description: string): RunnerConfigurationOption['models'] {
  return dedupeOptions(values.map((value) => {
    const [rawId, rawLabel, rawDescription] = value.split('|').map((part) => part.trim());
    const id = rawId || value.trim();
    return {
      id,
      label: rawLabel || titleFromSlug(id),
      description: rawDescription || description
    };
  }).filter((option) => option.id));
}

function dedupeOptions<T extends { id: string; label: string; description: string }>(options: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const option of options) {
    const key = option.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(option);
  }
  return result;
}

function relativeHint(workspacePath: string, filePath: string): string {
  return `Discovered from ${path.relative(workspacePath, filePath) || filePath}`;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function titleFromSlug(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function runnerConfigurationFor(
  id: string,
  label: string,
  githubDefaultModel: string,
  codexDefaultModel: string,
  claudeDefaultModel: string,
  discovery: RunnerDiscovery
): RunnerConfigurationOption {
  const commonTools = [
    { id: 'default-approvals', label: 'Default Approvals', description: 'Use the runner default tool and approval behavior.' },
    { id: 'read-only', label: 'Read-only inspection', description: 'Prefer analysis and file reading without writes.' },
    { id: 'workspace-edit', label: 'Workspace edit', description: 'Allow normal repository edits according to the permission profile.' },
    { id: 'mcp:', label: 'MCP tool prefix', description: 'Type mcp:tool-name to pass a known Copilot CLI MCP tool as --allow-tool.' },
    ...discovery.toolProfiles
  ];

  if (id.startsWith('copilot')) {
    const models = withConfiguredDefaultModel(
      dedupeOptions([
        { id: 'provider-default', label: 'Auto / provider default', description: 'Let Copilot choose the configured default model.' },
        { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Use when available in the current Copilot organization.' },
        { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Use when available in the current Copilot organization.' },
        { id: 'claude-opus-4.6', label: 'Claude Opus 4.6', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'claude-opus-4.6-fast', label: 'Claude Opus 4.6 Fast', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Use when available in the current Copilot plan.' },
        { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Use when available in the current Copilot organization.' },
        { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Use when available in the current Copilot organization.' },
        { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Use when your GitHub Copilot CLI exposes this model id.' },
        { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'Use when available in the current Copilot organization.' },
        { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Use when available in the current Copilot organization.' },
        { id: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex Max', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'gpt-5.1-codex', label: 'GPT-5.1-Codex', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'gpt-5.1', label: 'GPT-5.1', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex Mini', description: 'Use when available in the current GitHub Copilot organization.' },
        { id: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Use when available in the current Copilot organization.' },
        ...discovery.githubModels
      ]),
      githubDefaultModel
    );
    return {
      id,
      label,
      description: 'GitHub Copilot local or cloud execution.',
      defaultModelId: configuredDefaultModelId(githubDefaultModel),
      agents: dedupeOptions([
        { id: 'default-agent', label: 'Default Copilot agent', description: 'Use the agent selected by the Copilot runtime.' },
        ...discovery.githubAgents
      ]),
      models,
      toolsProfiles: commonTools
    };
  }

  if (id.startsWith('codex')) {
    const models = withConfiguredDefaultModel(
      dedupeOptions([
        { id: 'provider-default', label: 'Auto / Codex configured model', description: 'Let Codex use its configured model.' },
        { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Use when available in the current Codex installation.' },
        { id: 'gpt-5', label: 'GPT-5', description: 'Use when available in the current account/provider.' },
        ...discovery.codexModels
      ]),
      codexDefaultModel
    );
    return {
      id,
      label,
      description: 'OpenAI Codex local, cloud, or manual handoff execution.',
      defaultModelId: configuredDefaultModelId(codexDefaultModel),
      agents: dedupeOptions([
        { id: 'default-agent', label: 'Default Codex profile', description: 'Use the profile configured in Codex.' },
        ...discovery.codexAgents
      ]),
      models,
      toolsProfiles: commonTools
    };
  }

  if (id.startsWith('claude')) {
    const models = withConfiguredDefaultModel(
        dedupeOptions([
          { id: 'provider-default', label: 'Auto / Claude configured model', description: 'Let Claude Code use its configured model.' },
          { id: 'sonnet', label: 'Sonnet alias', description: 'Use the current Claude Code Sonnet alias.' },
          { id: 'opus', label: 'Opus alias', description: 'Use the current Claude Code Opus alias.' },
          ...discovery.claudeModels
        ]),
      claudeDefaultModel
    );
    return {
      id,
      label,
      description: 'Claude Code local non-interactive CLI execution.',
      defaultModelId: configuredDefaultModelId(claudeDefaultModel),
      agents: dedupeOptions([
        { id: 'default-agent', label: 'Default Claude profile', description: 'Use the profile configured in Claude Code.' },
        ...discovery.claudeAgents
      ]),
      models,
      toolsProfiles: commonTools
    };
  }

  return {
    id,
    label,
    description: 'Generic or manual execution runner.',
    defaultModelId: 'provider-default',
    agents: [
      { id: 'default-agent', label: 'Default agent', description: 'Use the generic task profile.' }
    ],
    models: [
      { id: 'provider-default', label: 'Provider default', description: 'Use the command or manual workflow default.' }
    ],
    toolsProfiles: commonTools
  };
}

function configuredDefaultModelId(value: string): string {
  const model = normalizeOptionalString(value);
  return !model || model.toLowerCase() === 'auto' ? 'provider-default' : model;
}

function withConfiguredDefaultModel(
  models: RunnerConfigurationOption['models'],
  configuredModel: string
): RunnerConfigurationOption['models'] {
  const defaultModelId = configuredDefaultModelId(configuredModel);
  if (models.some((model) => model.id === defaultModelId)) {
    return models;
  }
  return [
    {
      id: defaultModelId,
      label: `${defaultModelId} (configured default)`,
      description: 'Model inherited from AgenticKanbasutra settings.'
    },
    ...models
  ];
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
