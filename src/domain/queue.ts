import { Priority, TaskSpec } from './types';

const priorityWeight: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
};

export function sortQueuedTasks(tasks: TaskSpec[]): TaskSpec[] {
  return [...tasks].sort((a, b) => {
    const priorityDelta = priorityWeight[a.priority] - priorityWeight[b.priority];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const rankDelta = (a.queueRank ?? Number.MAX_SAFE_INTEGER) - (b.queueRank ?? Number.MAX_SAFE_INTEGER);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    return (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt);
  });
}

export function assignQueueRanks(tasks: TaskSpec[]): TaskSpec[] {
  return tasks.map((task, index) => ({
    ...task,
    queueRank: index + 1,
    updatedAt: new Date().toISOString()
  }));
}

