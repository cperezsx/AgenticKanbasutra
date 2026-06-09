import { TaskContextItem, TaskSpec } from '../domain/types';

export function buildTaskContextSection(task: TaskSpec): string[] {
  const lines: string[] = [];
  const items = task.contextItems?.filter(hasContextValue) ?? [];

  if (items.length > 0) {
    lines.push('', '## Attached Context', '');
    for (const item of items) {
      const suffix = item.path ? `: ${item.path}` : '';
      lines.push(`- ${item.kind}: ${item.label}${suffix}`);
      if (item.description?.trim()) {
        lines.push(`  Purpose: ${item.description.trim()}`);
      }
      if (item.content?.trim()) {
        lines.push('', item.content.trim(), '');
      }
    }
  }

  if (task.notes?.trim()) {
    lines.push('', '## Additional Notes', '', task.notes.trim());
  }

  return lines;
}

function hasContextValue(item: TaskContextItem): boolean {
  return Boolean(item.label?.trim() || item.path?.trim() || item.content?.trim());
}
