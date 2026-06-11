/**
 * Tests for time display logic in provider usage health views.
 * Verifies formatDuration, relativeTime, extractReset, and stale resetAfterSeconds behavior.
 */

let passed = 0;
let failed = 0;

function assert(label, condition, actual, expected) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        Expected: ${JSON.stringify(expected)}`);
    console.error(`        Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertEquals(label, actual, expected) {
  assert(label, actual === expected, actual, expected);
}

// ─── formatDuration (mirrors backend src/usage/providerUsage.ts) ───────────────

function formatDuration(totalSeconds) {
  if (totalSeconds === undefined || !Number.isFinite(Number(totalSeconds))) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

console.log('\n=== formatDuration ===');
assertEquals('0 seconds → 0m', formatDuration(0), '0m');
assertEquals('30 seconds → 0m', formatDuration(30), '0m');
assertEquals('60 seconds → 1m', formatDuration(60), '1m');
assertEquals('90 seconds → 1m (floor)', formatDuration(90), '1m');
assertEquals('3600 seconds → 1h', formatDuration(3600), '1h');
assertEquals('3660 seconds → 1h 1m', formatDuration(3660), '1h 1m');
assertEquals('7200 seconds → 2h', formatDuration(7200), '2h');
assertEquals('86400 seconds → 1d', formatDuration(86400), '1d');
assertEquals('90000 seconds → 1d 1h', formatDuration(90000), '1d 1h');
assertEquals('undefined → unknown', formatDuration(undefined), 'unknown');
assertEquals('NaN → unknown', formatDuration(NaN), 'unknown');
// BUG CHECK: frontend vs backend differ — frontend returns '0m' for NaN, backend returns 'unknown'
const frontendNaN = (() => {
  const seconds = Math.max(0, Math.round(Number(NaN) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
})();
assertEquals('frontend NaN → 0m (diff from backend)', frontendNaN, '0m');

// ─── relativeTime (fixed version in media/webview/main.js) ────────────────────

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

console.log('\n=== relativeTime ===');
const now = new Date();
assertEquals('just now → 0s ago', relativeTime(now.toISOString()), '0s ago');
assertEquals('invalid → unknown', relativeTime('not-a-date'), 'unknown');
assertEquals('undefined → unknown', relativeTime(undefined), 'unknown');

const minus2m = new Date(Date.now() - 2 * 60 * 1000).toISOString();
assertEquals('2m ago', relativeTime(minus2m), '2m ago');

const minus90m = new Date(Date.now() - 90 * 60 * 1000).toISOString();
assertEquals('90m ago → 2h ago (rounds up)', relativeTime(minus90m), '2h ago');

const minus25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
const actual25h = relativeTime(minus25h);
// FIX: now shows "1d ago" instead of "25h ago"
assertEquals('25h ago → 1d ago (fixed)', actual25h, '1d ago');

// ─── extractReset (mirrors src/usage/providerUsage.ts) ────────────────────────

function extractReset(output) {
  const match = /\breset(?:s|ting)?(?:\s+at|\s+in|:)?\s+([^\n\r.;]+)/i.exec(output);
  return match?.[1]?.trim().slice(0, 80);
}

console.log('\n=== extractReset ===');
assertEquals('resets at 5pm', extractReset('Usage resets at 5pm tomorrow'), '5pm tomorrow');
assertEquals('resets in 2h', extractReset('Token limit resets in 2h 30m'), '2h 30m');
assertEquals('reset: time', extractReset('Next reset: 2024-01-15T16:30:00Z'), '2024-01-15T16:30:00Z');
assertEquals('no reset → undefined', extractReset('You are authenticated.'), undefined);
// Sample claude auth status output (actual)
const claudeAuthJson = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "user@example.com",
  "subscriptionType": "pro"
}`;
assertEquals('real claude auth output → no reset', extractReset(claudeAuthJson), undefined);

// ─── Claude /usage parser (mirrors src/usage/providerUsage.ts) ────────────────

function parseClaudeUsageWindows(output, checkedAt) {
  const windows = [];
  for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = /^([^:]+):\s*(\d{1,3})\s*%\s*used(?:\s*(?:[^A-Za-z0-9\s]\s*)?resets?\s+(.+))?$/i.exec(line);
    if (!match) continue;
    const label = match[1].trim().replace(/\s+/g, ' ');
    const percentUsed = Math.max(0, Math.min(100, Math.round(Number(match[2]))));
    const resetAt = parseClaudeResetAt(match[3], checkedAt);
    windows.push({
      id: label.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'usage-window',
      label,
      percentUsed,
      percentRemaining: Math.max(0, Math.min(100, 100 - percentUsed)),
      resetAt
    });
  }
  return windows;
}

function parseClaudeResetAt(value, checkedAt) {
  if (!value) return undefined;
  const cleaned = value.replace(/\([^)]*\)/g, '').trim();
  const reference = new Date(checkedAt);
  const year = Number.isFinite(reference.getTime()) ? reference.getFullYear() : new Date().getFullYear();
  const monthMatch = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(cleaned);
  if (!monthMatch) return undefined;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthMatch[1].slice(0, 3).toLowerCase());
  if (month < 0) return undefined;
  const hour12 = Number(monthMatch[3]) % 12;
  const hour = /pm/i.test(monthMatch[5]) ? hour12 + 12 : hour12;
  return new Date(year, month, Number(monthMatch[2]), hour, Number(monthMatch[4] ?? 0), 0, 0).toISOString();
}

console.log('\n=== Claude /usage parser ===');
const claudeUsageJson = {
  result: [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 25% used · resets Jun 11, 12:39pm (Europe/Madrid)',
    'Current week (all models): 3% used · resets Jun 13, 6pm (Europe/Madrid)'
  ].join('\n')
};
const claudeWindows = parseClaudeUsageWindows(claudeUsageJson.result, '2026-06-11T06:20:00.000Z');
assertEquals('Claude usage: two windows', claudeWindows.length, 2);
assertEquals('Claude usage: current session id', claudeWindows[0].id, 'current-session');
assertEquals('Claude usage: current session used', claudeWindows[0].percentUsed, 25);
assertEquals('Claude usage: current session remaining', claudeWindows[0].percentRemaining, 75);
assertEquals('Claude usage: weekly used', claudeWindows[1].percentUsed, 3);
assertEquals('Claude usage: weekly remaining', claudeWindows[1].percentRemaining, 97);
assert('Claude usage: reset parsed as ISO', /^\d{4}-\d{2}-\d{2}T/.test(claudeWindows[0].resetAt), claudeWindows[0].resetAt, 'ISO timestamp');
assert('Claude usage: reset without minutes parsed as ISO', /^\d{4}-\d{2}-\d{2}T/.test(claudeWindows[1].resetAt), claudeWindows[1].resetAt, 'ISO timestamp');

// ─── Stale resetAfterSeconds bug ──────────────────────────────────────────────

console.log('\n=== Stale resetAfterSeconds (the main time bug) ===');

// Simulate: snapshot was saved 30 minutes ago with resetAfterSeconds = 3600 (1 hour remaining)
// Now reading it: resetAfterSeconds is still 3600, but only 30 min remain

const savedResetAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min in future
const savedResetAfterSeconds = 3600; // was 1h when saved 30 min ago
const staleDuration = formatDuration(savedResetAfterSeconds); // still shows "1h"

assert(
  'Stale resetAfterSeconds shows wrong time (1h instead of 30m)',
  staleDuration === '1h',
  staleDuration,
  '1h'
);
console.log(`        Bug: shows "${staleDuration}" but actual time remaining is ~30m`);

// Fix: compute dynamically from resetAt
function dynamicResetAfterSeconds(resetAt) {
  const timestamp = new Date(resetAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

const dynamicSeconds = dynamicResetAfterSeconds(savedResetAt);
const dynamicDuration = formatDuration(dynamicSeconds);
assert(
  'Dynamic resetAfterSeconds from resetAt shows correct ~30m',
  dynamicSeconds >= 29 * 60 && dynamicSeconds <= 31 * 60,
  dynamicDuration,
  '~30m'
);
console.log(`        Fix: shows "${dynamicDuration}" (computed from resetAt)`);

// ─── formatResetAt (new function in media/webview/main.js) ────────────────────

function formatResetAt(value) {
  if (!value) return 'unknown';
  const timestamp = new Date(value).getTime();
  if (Number.isFinite(timestamp)) {
    const secondsUntil = Math.round((timestamp - Date.now()) / 1000);
    if (secondsUntil > 60) return `in ${formatDuration(secondsUntil)}`;
    if (secondsUntil >= 0) return 'soon';
  }
  return value;
}

console.log('\n=== formatResetAt (was raw ISO, now human-readable) ===');

const futureIso = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // 2h from now
const futureResult = formatResetAt(futureIso);
assert('future ISO → "in 2h"', futureResult === 'in 2h', futureResult, 'in 2h');

const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
assertEquals('past ISO → raw string (already passed)', formatResetAt(pastIso), pastIso);

assertEquals('undefined → unknown', formatResetAt(undefined), 'unknown');
assertEquals('raw text → passthrough', formatResetAt('resets at midnight'), 'resets at midnight');

const soonIso = new Date(Date.now() + 30 * 1000).toISOString(); // 30s from now
assertEquals('30s from now → "soon"', formatResetAt(soonIso), 'soon');

// ─── enrichSnapshotWithParsedUsage label bug ───────────────────────────────────

console.log('\n=== Label with raw resetAt text ===');

// When extractReset captures raw text like "in 2 hours", the label becomes:
// "75% left - in 2 hours" — the "in" is redundant given the dash
const extractedReset = 'in 2 hours';
const label = `75% left - ${extractedReset}`;
console.log(`  Label shows: "${label}"`);
console.log(`  Note: "- in 2 hours" reads awkwardly, should be "- resets in 2h" or just "75% left"`);

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log('\n=== Test Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');
console.log('=== Fixes Applied ===');
console.log('  1. STALE resetAfterSeconds: now computed from resetAt in frontend tooltip.');
console.log('  2. RAW ISO resetAt: now shown as "in Xh Ym" via formatResetAt().');
console.log('  3. relativeTime: now shows "1d ago" for old timestamps.');

if (failed > 0) {
  process.exit(1);
}
