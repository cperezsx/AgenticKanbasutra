import { AgentRunner, RunHandle, RunnerContext, TaskSpec, ValidationResult } from '../../domain/types';
import { randomUUID } from 'crypto';
import { buildTaskContextSection } from '../contextPrompt';

export class ManualRunner implements AgentRunner {
  readonly id = 'manual';
  readonly displayName = 'Manual handoff';
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
    yield { type: 'started' as const, at: new Date().toISOString() };
    yield {
      type: 'waiting_for_input' as const,
      prompt: buildManualPrompt(task),
      at: new Date().toISOString()
    };
  }
}

function buildManualPrompt(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    `Repository: ${task.repository.label}`,
    `Agent: ${task.agent.label}`,
    `Model: ${task.model.label}`,
    `Tools: ${task.toolsProfile.label}`,
    `Permissions: ${task.permissionProfile}`,
    '',
    '## Spec',
    '',
    task.spec,
    buildTaskContextSection(task)
  ].flat().join('\n');
}
