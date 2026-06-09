import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AgentRunner, RunHandle, RunnerContext, TaskSpec, ValidationResult } from '../../domain/types';
import { buildCodexPrompt } from './prompt';

export class CodexManualRunner implements AgentRunner {
  readonly id = 'codex-manual';
  readonly displayName = 'Codex Manual Handoff';
  readonly capabilities = {
    canRunInBackground: false,
    canCancel: false,
    writesFiles: false
  };

  async validate(): Promise<ValidationResult> {
    return { valid: true, errors: [] };
  }

  async start(task: TaskSpec, _context: RunnerContext): Promise<RunHandle> {
    return {
      runId: randomUUID(),
      events: this.createEvents(task)
    };
  }

  async cancel(): Promise<void> {
    return;
  }

  private async *createEvents(task: TaskSpec) {
    const prompt = buildCodexPrompt(task);
    await vscode.env.clipboard.writeText(prompt);
    try {
      await vscode.commands.executeCommand('chatgpt.newCodexPanel');
    } catch {
      try {
        await vscode.commands.executeCommand('chatgpt.openSidebar');
      } catch {
        // The prompt is still copied even if the Codex extension command is unavailable.
      }
    }
    yield { type: 'started' as const, at: new Date().toISOString() };
    yield {
      type: 'waiting_for_input' as const,
      prompt: [
        'Codex prompt copied to clipboard.',
        '',
        'Paste it into the Codex panel or sidebar to run this task interactively.',
        '',
        '## Prompt',
        '',
        prompt
      ].join('\n'),
      at: new Date().toISOString()
    };
  }
}
