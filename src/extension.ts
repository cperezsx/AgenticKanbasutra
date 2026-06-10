import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator/orchestrator';
import { checkClaudeEnvironment } from './runners/claude/claudeEnvironment';
import { checkCodexEnvironment } from './runners/codex/codexEnvironment';
import { checkCopilotEnvironment } from './runners/copilot/copilotEnvironment';
import { RunnerRegistry } from './runners/runnerRegistry';
import { AgenticStatusBar, showStatusBarActions } from './status/statusBar';
import { TaskStore } from './storage/taskStore';
import { BoardProvider } from './webview/boardProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  const store = new TaskStore(context.globalStorageUri.fsPath);
  const registry = new RunnerRegistry();
  const orchestrator = new Orchestrator(store, registry, context);
  const boardProvider = new BoardProvider(context, store, orchestrator, registry);
  const statusBar = new AgenticStatusBar(store, orchestrator);

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(BoardProvider.viewType, boardProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('agenticKanbasutra.open', async () => {
      await boardProvider.revealBoard();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.newTask', async () => {
      await boardProvider.revealNewTask();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.runNext', async () => {
      await orchestrator.runNext();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.toggleQueue', async () => {
      orchestrator.setQueuePaused(!orchestrator.isQueuePaused());
      if (!orchestrator.isQueuePaused()) {
        await orchestrator.drainAutomaticQueue();
      }
    }),
    vscode.commands.registerCommand('agenticKanbasutra.statusBarActions', async () => {
      await showStatusBarActions(orchestrator);
    }),
    vscode.commands.registerCommand('agenticKanbasutra.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'agenticKanbasutra');
    }),
    vscode.commands.registerCommand('agenticKanbasutra.cleanupCompleted', async () => {
      await boardProvider.cleanupCompleted(true);
    }),
    vscode.commands.registerCommand('agenticKanbasutra.checkCopilot', async () => {
      const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const report = await checkCopilotEnvironment(repositoryPath);
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: report.markdown
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('agenticKanbasutra.checkCodex', async () => {
      const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const report = await checkCodexEnvironment(repositoryPath);
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: report.markdown
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('agenticKanbasutra.checkClaude', async () => {
      const repositoryPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const report = await checkClaudeEnvironment(repositoryPath);
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: report.markdown
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('agenticKanbasutra.checkCodexUsage', async () => {
      await boardProvider.checkCodexUsage();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.checkClaudeUsage', async () => {
      await boardProvider.checkClaudeUsage();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.viewCopilotUsage', async () => {
      await boardProvider.viewCopilotUsage();
    }),
    vscode.commands.registerCommand('agenticKanbasutra.updateProviderHealth', async () => {
      await boardProvider.updateProviderHealth();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agenticKanbasutra')) {
        void boardProvider.postState();
        void statusBar.refresh();
      }
      if (
        event.affectsConfiguration('agenticKanbasutra.queue.executionMode') ||
        event.affectsConfiguration('agenticKanbasutra.queue.maxConcurrent')
      ) {
        void orchestrator.drainAutomaticQueue();
      }
    }),
    orchestrator.onDidChange.event(() => {
      void statusBar.refresh();
    }),
    store.onDidChange.event(() => {
      void statusBar.refresh();
    })
  );

  await boardProvider.cleanupCompleted(false);
  await statusBar.refresh();
}

export function deactivate(): void {
  return;
}
