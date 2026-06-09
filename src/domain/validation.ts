import { TaskSpec, ValidationResult } from './types';

const requiredTextFields: Array<[keyof TaskSpec, string]> = [
  ['title', 'title'],
  ['spec', 'spec']
];

export function validateTask(task: Partial<TaskSpec>): ValidationResult {
  const errors: string[] = [];

  for (const [key, label] of requiredTextFields) {
    const value = task[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${label} is required.`);
    }
  }

  if (!task.repository?.label) {
    errors.push('repository is required.');
  }
  if (!task.runner?.id) {
    errors.push('runner is required.');
  }
  if (!task.agent?.id) {
    errors.push('agent is required.');
  }
  if (!task.model?.id) {
    errors.push('model is required.');
  }
  if (!task.toolsProfile?.id) {
    errors.push('toolsProfile is required.');
  }
  if (!task.executionMode) {
    errors.push('executionMode is required.');
  }
  if (!task.isolationMode) {
    errors.push('isolationMode is required.');
  }
  if (!task.permissionProfile) {
    errors.push('permissionProfile is required.');
  }
  if (!task.priority) {
    errors.push('priority is required.');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function isFinalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

export function statusToColumn(status: string): 'pending' | 'queued' | 'running' | 'failed' | 'completed' {
  if (status === 'queued') {
    return 'queued';
  }
  if (status === 'running' || status === 'waiting_for_input' || status === 'waiting_for_approval') {
    return 'running';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (isFinalStatus(status)) {
    return 'completed';
  }
  return 'pending';
}
