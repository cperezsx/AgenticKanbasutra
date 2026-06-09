import { TaskSpec } from '../../domain/types';
import { buildTaskContextSection } from '../contextPrompt';

export function buildCopilotPrompt(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    'You are executing an AgenticKanbasutra task.',
    '',
    '## Task Metadata',
    '',
    `- Repository: ${task.repository.label}`,
    `- Priority: ${task.priority}`,
    `- Agent: ${task.agent.label}`,
    `- Model: ${task.model.label}`,
    `- Tools profile: ${task.toolsProfile.label}`,
    `- Execution mode: ${task.executionMode}`,
    `- Isolation mode: ${task.isolationMode}`,
    `- Permission profile: ${task.permissionProfile}`,
    task.branchBase ? `- Base branch: ${task.branchBase}` : undefined,
    task.linkedIssue ? `- Linked issue: ${task.linkedIssue}` : undefined,
    '',
    '## Operating Rules',
    '',
    '- Work only on the requested task.',
    '- Prefer the smallest coherent change that satisfies the spec.',
    '- Keep unrelated files untouched.',
    '- Run relevant checks when practical.',
    '- Summarize what changed, what was verified, and what remains risky.',
    '',
    '## Task Spec',
    '',
    task.spec,
    buildTaskContextSection(task)
  ]
    .flat()
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
