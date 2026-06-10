import * as vscode from 'vscode';
import { TaskSpec } from '../domain/types';
import { isFinalStatus } from '../domain/validation';
import { Orchestrator } from '../orchestrator/orchestrator';
import { TaskStore } from '../storage/taskStore';

export class AgenticStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly store: TaskStore,
    private readonly orchestrator: Orchestrator
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.item.command = 'agenticKanbasutra.statusBarActions';
    this.item.name = 'AgenticKanbasutra';
  }

  dispose(): void {
    this.item.dispose();
  }

  async refresh(): Promise<void> {
    const tasks = await this.store.getTasks();
    const summary = summarize(tasks, this.orchestrator.isQueuePaused(), this.orchestrator.getQueueExecutionMode(), this.orchestrator.getQueueMaxConcurrent());
    this.item.text = summary.text;
    this.item.tooltip = new vscode.MarkdownString(summary.tooltip);
    this.item.backgroundColor = summary.alertCount > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }
}

export async function showStatusBarActions(orchestrator: Orchestrator): Promise<void> {
  const pauseLabel = orchestrator.isQueuePaused() ? 'Resume queue' : 'Pause queue';
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(layout) Open board in editor', command: 'agenticKanbasutra.open' },
      { label: '$(add) New task', command: 'agenticKanbasutra.newTask' },
      { label: '$(play) Run next task', command: 'agenticKanbasutra.runNext' },
      { label: orchestrator.isQueuePaused() ? '$(debug-continue) Resume queue' : '$(debug-pause) Pause queue', command: 'agenticKanbasutra.toggleQueue' },
      { label: '$(shield) Check Copilot setup', command: 'agenticKanbasutra.checkCopilot' },
      { label: '$(hubot) Check Codex setup', command: 'agenticKanbasutra.checkCodex' },
      { label: '$(sparkle) Check Claude setup', command: 'agenticKanbasutra.checkClaude' },
      { label: '$(pulse) Check Codex usage', command: 'agenticKanbasutra.checkCodexUsage' },
      { label: '$(pulse) Check Claude usage', command: 'agenticKanbasutra.checkClaudeUsage' },
      { label: '$(link-external) View Copilot usage', command: 'agenticKanbasutra.viewCopilotUsage' },
      { label: '$(sync) Update provider health', command: 'agenticKanbasutra.updateProviderHealth' },
      { label: '$(settings-gear) Open AgenticKanbasutra settings', command: 'agenticKanbasutra.openSettings' }
    ],
    {
      title: 'AgenticKanbasutra',
      placeHolder: pauseLabel
    }
  );

  if (choice) {
    await vscode.commands.executeCommand(choice.command);
  }
}

function summarize(tasks: TaskSpec[], paused: boolean, queueMode: string, maxConcurrent: number): { text: string; tooltip: string; alertCount: number } {
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  const waiting = tasks.filter((task) => task.status === 'waiting_for_input' || task.status === 'waiting_for_approval').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const completed = tasks.filter((task) => isFinalStatus(task.status)).length;
  const alertCount = waiting + failed;

  const icon = alertCount > 0 ? '$(warning)' : paused ? '$(debug-pause)' : '$(kanban)';
  const text = `${icon} AK ${queued}Q ${running + waiting}R${alertCount > 0 ? ` ${alertCount}A` : ''}`;
  const tooltip = [
    '**AgenticKanbasutra**',
    '',
    `- Queue: ${paused ? 'paused' : 'active'} (${queueMode})`,
    `- Max concurrent: ${maxConcurrent}`,
    `- Queued: ${queued}`,
    `- Running: ${running}`,
    `- Waiting: ${waiting}`,
    `- Failed: ${failed}`,
    `- Done: ${completed}`,
    '',
    'Click for board, checks, queue controls, and settings.'
  ].join('\n');

  return { text, tooltip, alertCount };
}
