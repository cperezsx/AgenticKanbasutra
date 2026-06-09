import { SerializedError } from './types';

export function categorizeFailure(message: string): SerializedError['category'] {
  const normalized = message.toLowerCase();

  if (containsAny(normalized, ['token', 'context length', 'context window', 'maximum context', 'too many tokens'])) {
    return 'token_exhausted';
  }
  if (containsAny(normalized, ['quota', 'rate limit', 'rate_limit', 'insufficient credits', 'billing', 'payment required'])) {
    return 'quota_exhausted';
  }
  if (containsAny(normalized, ['unauthorized', 'forbidden', 'api key', 'authentication', 'auth'])) {
    return 'auth_required';
  }
  if (containsAny(normalized, ['permission', 'workspace trust', 'not trusted'])) {
    return 'permission_denied';
  }
  if (containsAny(normalized, ['command template', 'not configured', 'configuration', 'repository path'])) {
    return 'configuration';
  }
  if (containsAny(normalized, ['network', 'enotfound', 'econnreset', 'timeout', 'timed out'])) {
    return 'network';
  }

  return 'unknown';
}

export function isRecoverableResourceFailure(category: SerializedError['category']): boolean {
  return category === 'token_exhausted'
    || category === 'quota_exhausted'
    || category === 'auth_required'
    || category === 'permission_denied'
    || category === 'configuration'
    || category === 'network';
}

export function buildFailureSummary(title: string, error: SerializedError): string {
  const retryHint = isRecoverableResourceFailure(error.category)
    ? 'This task was moved to DONE to avoid blocking the queue. Fix the resource issue, then re-enqueue or duplicate the task.'
    : 'Review the error, then re-enqueue or duplicate the task if it should be retried.';

  return [
    `# ${title}`,
    '',
    `Status: failed`,
    `Category: ${error.category}`,
    '',
    '## What happened',
    '',
    error.message,
    '',
    '## Recovery',
    '',
    retryHint
  ].join('\n');
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

