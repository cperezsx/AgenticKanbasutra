import { AgentRunner } from '../domain/types';
import { ClaudeCliRunner } from './claude/claudeCliRunner';
import { CodexCliRunner } from './codex/codexCliRunner';
import { CodexCloudRunner } from './codex/codexCloudRunner';
import { CodexManualRunner } from './codex/codexManualRunner';
import { CopilotCliRunner } from './copilot/copilotCliRunner';
import { CopilotCloudRunner } from './copilot/copilotCloudRunner';
import { GenericCliRunner } from './genericCli/genericCliRunner';
import { ManualRunner } from './manual/manualRunner';

export class RunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  constructor() {
    this.register(new ManualRunner());
    this.register(new GenericCliRunner());
    this.register(new CopilotCliRunner());
    this.register(new CopilotCloudRunner());
    this.register(new ClaudeCliRunner());
    this.register(new CodexCliRunner());
    this.register(new CodexCloudRunner());
    this.register(new CodexManualRunner());
  }

  all(): AgentRunner[] {
    return [...this.runners.values()];
  }

  get(id: string): AgentRunner | undefined {
    return this.runners.get(id);
  }

  private register(runner: AgentRunner): void {
    this.runners.set(runner.id, runner);
  }
}
