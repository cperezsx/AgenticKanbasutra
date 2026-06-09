import { TaskSpec } from '../../domain/types';
import { buildTaskContextSection } from '../contextPrompt';

export function buildClaudePrompt(task: TaskSpec): string {
  return [
    `# ${task.title}`,
    '',
    'You are executing an AgenticKanbasutra task with Claude Code.',
    '',
    '## Task Metadata',
    '',
    `- Repository: ${task.repository.label}`,
    `- Priority: ${task.priority}`,
    `- Agent/Profile: ${task.agent.label}`,
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
    '- Keep unrelated files untouched.',
    '- Prefer minimal, reviewable changes.',
    '- Respect the configured permission mode and repository boundary.',
    '- Run relevant checks when practical.',
    '- End with a concise summary of changes, verification, and remaining risks.',
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
