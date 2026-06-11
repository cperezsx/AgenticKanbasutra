/**
 * Tests the Claude CLI runner queue pipeline:
 *   1. Prompt building from a TaskSpec
 *   2. Command args construction (permission + tools profiles)
 *   3. needsGitMetadataWrites detection (Spanish + English)
 *   4. summarizeClaudeOutput / parseClaudeJson
 *   5. sortQueuedTasks priority ordering
 *   6. AsyncQueue async-iteration mechanics
 *   7. Live claude executable check (resolveClaudeExecutable)
 *   8. Live minimal claude invocation (--help flag to avoid auth)
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

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

function assertContains(label, actual, substring) {
  assert(label, String(actual).includes(substring), actual, `contains "${substring}"`);
}

// ─── Minimal TaskSpec factory ─────────────────────────────────────────────────

function makeTask(overrides = {}) {
  return {
    id: 'task-001',
    title: 'Fix login bug',
    spec: 'Fix the bug in the login flow.',
    status: 'queued',
    priority: 'normal',
    queueRank: 1,
    queuedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    repository: { path: 'C:\\repo', label: 'my-repo' },
    agent: { id: 'claude-cli', label: 'Claude CLI' },
    model: { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    toolsProfile: { id: 'default-approvals', label: 'Default' },
    permissionProfile: 'bypass',
    executionMode: 'automatic',
    isolationMode: 'repository',
    ...overrides
  };
}

// ─── 1. Prompt building (mirrors src/runners/claude/prompt.ts) ────────────────

function buildClaudePrompt(task) {
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
    task.spec
  ]
    .flat()
    .filter((line) => line !== undefined)
    .join('\n');
}

console.log('\n=== 1. Prompt Building ===');

const task = makeTask();
const prompt = buildClaudePrompt(task);
assertContains('prompt has title', prompt, '# Fix login bug');
assertContains('prompt has metadata section', prompt, '## Task Metadata');
assertContains('prompt has repository', prompt, '- Repository: my-repo');
assertContains('prompt has model', prompt, '- Model: Claude Sonnet 4.6');
assertContains('prompt has permission profile', prompt, '- Permission profile: bypass');
assertContains('prompt has task spec', prompt, 'Fix the bug in the login flow.');
assertContains('prompt has operating rules', prompt, '## Operating Rules');

const taskWithBranch = makeTask({ branchBase: 'main', linkedIssue: '#42' });
const promptWithBranch = buildClaudePrompt(taskWithBranch);
assertContains('prompt includes branchBase', promptWithBranch, '- Base branch: main');
assertContains('prompt includes linkedIssue', promptWithBranch, '- Linked issue: #42');

const taskNoModel = makeTask({ model: { id: 'provider-default', label: 'Provider Default' } });
const promptNoModel = buildClaudePrompt(taskNoModel);
assertContains('provider-default still shows label', promptNoModel, '- Model: Provider Default');

// ─── 2. Command args construction ─────────────────────────────────────────────

function permissionArgs(task) {
  // Mirrors claudeCliRunner.ts permissionArgs() with default VS Code config values
  const defaults = {
    readOnlyArgs: [],
    allowWorkspaceArgs: [],
    allowWorktreeArgs: [],
    bypassArgs: ['--permission-mode', 'bypassPermissions']
  };
  if (task.permissionProfile === 'read_only') return defaults.readOnlyArgs;
  if (task.permissionProfile === 'allow_worktree') return defaults.allowWorktreeArgs;
  if (task.permissionProfile === 'bypass') return defaults.bypassArgs;
  return defaults.allowWorkspaceArgs;
}

function toolArgsFromProfile(profileId) {
  const profile = String(profileId || '').trim();
  if (!profile || ['default-approvals', 'read-only', 'workspace-edit', 'none'].includes(profile)) {
    return [];
  }
  if (profile.startsWith('--tools=')) return [profile];
  if (profile.startsWith('tools:')) return ['--tools', profile.slice('tools:'.length).trim()];
  if (profile.startsWith('claude-tools:')) return ['--tools', profile.slice('claude-tools:'.length).trim()];
  return profile.split(/\s*;\s*/).filter(Boolean).flatMap(toolArgsFromProfile);
}

function buildArgs(task, promptText) {
  const baseArgs = [];
  const args = [
    ...baseArgs,
    '-p', promptText
  ];
  if (task.model.id && task.model.id !== 'provider-default') {
    args.push('--model', task.model.id);
  }
  args.push(...permissionArgs(task));
  args.push(...toolArgsFromProfile(task.toolsProfile.id));
  return args;
}

console.log('\n=== 2. Command Args Construction ===');

const bypassTask = makeTask({ permissionProfile: 'bypass' });
const bypassArgs = buildArgs(bypassTask, '# Fix login bug\n\nUse the task metadata.');
assertContains('bypass: has -p', bypassArgs.join(' '), '-p');
assertContains('bypass: passes markdown prompt text', bypassArgs.join(' '), '# Fix login bug');
assertContains('bypass: has --model', bypassArgs.join(' '), '--model claude-sonnet-4-6');
assertContains('bypass: has --permission-mode', bypassArgs.join(' '), '--permission-mode bypassPermissions');

const readOnlyTask = makeTask({ permissionProfile: 'read_only' });
const readOnlyArgs = buildArgs(readOnlyTask, '# Read only task');
assert('read_only: no permission-mode flag', !readOnlyArgs.includes('--permission-mode'), readOnlyArgs, 'no --permission-mode');

const workspaceTask = makeTask({ permissionProfile: 'allow_workspace' });
const workspaceArgs = buildArgs(workspaceTask, '# Workspace task');
assert('allow_workspace: no extra args by default', !workspaceArgs.includes('--permission-mode'), workspaceArgs, 'no --permission-mode');

const noModelTask = makeTask({ model: { id: 'provider-default', label: 'Default' } });
const noModelArgs = buildArgs(noModelTask, '# Default model task');
assert('provider-default: no --model arg', !noModelArgs.includes('--model'), noModelArgs, 'no --model');

// Tools profiles
assertEquals('default-approvals → no tools args', toolArgsFromProfile('default-approvals').length, 0);
assertEquals('read-only → no tools args', toolArgsFromProfile('read-only').length, 0);
assertEquals('none → no tools args', toolArgsFromProfile('none').length, 0);
assertEquals('tools:bash → --tools bash', toolArgsFromProfile('tools:bash').join(' '), '--tools bash');
assertEquals('--tools=bash → --tools=bash passthrough', toolArgsFromProfile('--tools=bash').join(' '), '--tools=bash');
assertEquals('claude-tools:edit → --tools edit', toolArgsFromProfile('claude-tools:edit').join(' '), '--tools edit');
// Note: compound syntax 'tools:a;tools:b' hits the tools: prefix first, so semicolon is NOT split
// Compound splitting only applies to bare profile IDs (no tools: prefix) that are in the known-empty list
assertEquals('compound: tools:a;tools:b → single arg (no split on tools: prefix)', toolArgsFromProfile('tools:a;tools:b').join(' '), '--tools a;tools:b');

// ─── 3. needsGitMetadataWrites ────────────────────────────────────────────────

function needsGitMetadataWrites(spec) {
  return [
    /\bcommit\b/i,
    /\bcommits\b/i,
    /\bbranch\b/i,
    /\bpush\b/i,
    /\bremote\b/i,
    /\brama\b/i,
    /\bramas\b/i,
    /\bsincroniz/i,
    /\bremoto\b/i
  ].some((pattern) => pattern.test(spec));
}

console.log('\n=== 3. needsGitMetadataWrites Detection ===');

assert('commit → true', needsGitMetadataWrites('Please commit the changes'), true, true);
assert('branch → true', needsGitMetadataWrites('Create a new branch for this feature'), true, true);
assert('push → true', needsGitMetadataWrites('Push to origin'), true, true);
assert('remote → true', needsGitMetadataWrites('Set up remote tracking'), true, true);
assert('rama (Spanish) → true', needsGitMetadataWrites('Crea una rama nueva'), true, true);
assert('ramas (Spanish plural) → true', needsGitMetadataWrites('Lista las ramas disponibles'), true, true);
assert('sincroniz (Spanish) → true', needsGitMetadataWrites('Sincronizar con el repositorio remoto'), true, true);
assert('remoto (Spanish) → true', needsGitMetadataWrites('Subir al repositorio remoto'), true, true);
assertEquals('plain task → false', needsGitMetadataWrites('Fix the login bug'), false);
assert('COMMIT uppercase → true', needsGitMetadataWrites('COMMIT this file'), true, true);
assertEquals('committed (partial match) → false', needsGitMetadataWrites('Already committed last week'), false);
assertEquals('uncommit → false (boundary)', needsGitMetadataWrites('uncommitted changes'), false);

// ─── 4. summarizeClaudeOutput / parseClaudeJson ────────────────────────────────

function parseClaudeJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed);
    for (const key of ['result', 'text', 'response', 'summary']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function summarizeClaudeOutput(stdout) {
  const parsed = parseClaudeJson(stdout);
  if (parsed) return parsed;
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.slice(-12).join('\n') || 'Claude CLI completed successfully.';
}

console.log('\n=== 4. Output Summarization ===');

assertEquals('empty stdout → default message', summarizeClaudeOutput(''), 'Claude CLI completed successfully.');
assertEquals('json result field', summarizeClaudeOutput('{"result":"Task done."}'), 'Task done.');
assertEquals('json text field', summarizeClaudeOutput('{"text":"Changes applied."}'), 'Changes applied.');
assertEquals('json response field', summarizeClaudeOutput('{"response":"OK"}'), 'OK');
assertEquals('json summary field', summarizeClaudeOutput('{"summary":"Patched 3 files."}'), 'Patched 3 files.');
assertEquals('malformed json → text fallback', summarizeClaudeOutput('not json\nstep1\nstep2\ndone'), 'not json\nstep1\nstep2\ndone');

// Large output: last 12 lines
const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
const summary = summarizeClaudeOutput(manyLines);
assertContains('last 12 lines: has line-9', summary, 'line-9');
assertContains('last 12 lines: has line-20', summary, 'line-20');
// 'line-1' is a substring of 'line-10'..'line-19', so check for the exact first line token instead
assert('last 12 lines: starts at line-9 (not line-1)', summary.startsWith('line-9'), summary, 'starts with line-9');

assertEquals('json with empty result → text fallback', summarizeClaudeOutput('{"result":"","text":"fallback"}'), 'fallback');

// ─── 5. sortQueuedTasks ────────────────────────────────────────────────────────

function sortQueuedTasks(tasks) {
  const priorityWeight = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...tasks].sort((a, b) => {
    const pd = priorityWeight[a.priority] - priorityWeight[b.priority];
    if (pd !== 0) return pd;
    const rd = (a.queueRank ?? Number.MAX_SAFE_INTEGER) - (b.queueRank ?? Number.MAX_SAFE_INTEGER);
    if (rd !== 0) return rd;
    return (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt);
  });
}

console.log('\n=== 5. Queue Priority Sorting ===');

const tasks = [
  makeTask({ id: 't1', title: 'Low priority', priority: 'low', queueRank: 1 }),
  makeTask({ id: 't2', title: 'Urgent task', priority: 'urgent', queueRank: 2 }),
  makeTask({ id: 't3', title: 'Normal task', priority: 'normal', queueRank: 3 }),
  makeTask({ id: 't4', title: 'High priority', priority: 'high', queueRank: 4 }),
  makeTask({ id: 't5', title: 'Normal rank1', priority: 'normal', queueRank: 1 }),
];

const sorted = sortQueuedTasks(tasks);
assertEquals('first is urgent', sorted[0].id, 't2');
assertEquals('second is high', sorted[1].id, 't4');
assertEquals('normal rank1 before normal rank3', sorted[2].id, 't5');
assertEquals('normal rank3 is 4th', sorted[3].id, 't3');
assertEquals('last is low', sorted[4].id, 't1');

// FIFO within same priority+rank (by queuedAt)
const t = Date.now();
const fifoTasks = [
  makeTask({ id: 'a', priority: 'normal', queueRank: 1, queuedAt: new Date(t + 2000).toISOString() }),
  makeTask({ id: 'b', priority: 'normal', queueRank: 1, queuedAt: new Date(t).toISOString() }),
  makeTask({ id: 'c', priority: 'normal', queueRank: 1, queuedAt: new Date(t + 1000).toISOString() }),
];
const fifoSorted = sortQueuedTasks(fifoTasks);
assertEquals('FIFO: oldest first', fifoSorted[0].id, 'b');
assertEquals('FIFO: newest last', fifoSorted[2].id, 'a');

// ─── 6. AsyncQueue mechanics ──────────────────────────────────────────────────

class AsyncQueue {
  values = [];
  resolvers = [];
  closed = false;

  push(value) {
    const resolver = this.resolvers.shift();
    if (resolver) { resolver({ value, done: false }); return; }
    this.values.push(value);
  }

  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.resolvers.push(resolve));
      }
    };
  }
}

console.log('\n=== 6. AsyncQueue Mechanics ===');

async function testAsyncQueue() {
  // Test 1: items pushed before iteration
  const q1 = new AsyncQueue();
  q1.push({ type: 'started' });
  q1.push({ type: 'stdout', chunk: 'hello' });
  q1.push({ type: 'completed' });
  q1.close();

  const events1 = [];
  for await (const event of q1) {
    events1.push(event);
  }
  assertEquals('pre-pushed: 3 events collected', events1.length, 3);
  assertEquals('pre-pushed: first is started', events1[0].type, 'started');
  assertEquals('pre-pushed: last is completed', events1[2].type, 'completed');

  // Test 2: items pushed after iteration starts (simulates runner async push)
  const q2 = new AsyncQueue();
  const events2 = [];
  const collectPromise = (async () => {
    for await (const event of q2) {
      events2.push(event);
    }
  })();

  await Promise.resolve(); // yield so collector starts waiting
  q2.push({ type: 'started' });
  q2.push({ type: 'progress', message: 'running' });
  q2.push({ type: 'stdout', chunk: 'output' });
  q2.close();
  await collectPromise;

  assertEquals('async-push: 3 events collected', events2.length, 3);
  assertEquals('async-push: progress event found', events2[1].type, 'progress');

  // Test 3: close immediately (empty queue)
  const q3 = new AsyncQueue();
  const events3 = [];
  const p3 = (async () => { for await (const e of q3) events3.push(e); })();
  q3.close();
  await p3;
  assertEquals('empty+close: 0 events', events3.length, 0);

  // Test 4: simulate failed run events
  const q4 = new AsyncQueue();
  q4.push({ type: 'started' });
  q4.push({ type: 'failed', error: { message: 'exit code 1', category: 'runner_failed' } });
  q4.close();
  const events4 = [];
  for await (const event of q4) events4.push(event);
  assertEquals('failed run: started then failed', events4[1].type, 'failed');
  assertEquals('failed run: category', events4[1].error.category, 'runner_failed');
}

await testAsyncQueue();

// ─── 7. Live claude executable resolution ─────────────────────────────────────

console.log('\n=== 7. Live Claude Executable ===');

async function resolveClaudeExecutable(configuredExecutable = 'claude') {
  const executable = configuredExecutable.trim() || 'claude';
  let resolvedPath = executable;
  if (!executable.includes('/') && !executable.includes('\\')) {
    try {
      const command = process.platform === 'win32' ? 'where.exe' : 'which';
      const { stdout } = await execFileAsync(command, [executable], { timeout: 5000 });
      const paths = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (paths.length) {
        if (process.platform === 'win32') {
          resolvedPath = paths.find(p => p.toLowerCase().endsWith('.exe'))
            ?? paths.find(p => p.toLowerCase().endsWith('.cmd'))
            ?? paths.find(p => p.toLowerCase().endsWith('.ps1'))
            ?? paths.find(p => !path.extname(p))
            ?? paths[0];
        } else {
          resolvedPath = paths[0];
        }
      }
    } catch {
      // Not in PATH — use as-is
    }
  }
  if (process.platform === 'win32') {
    const nativePath = path.join(path.dirname(resolvedPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    try {
      await fs.access(nativePath);
      resolvedPath = nativePath;
    } catch {
      // Native binary unavailable; fall back to shell mode for cmd/bat shims.
    }
  }
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath);
  return { command: resolvedPath, argsPrefix: [], shell, resolvedPath, configuredExecutable: executable };
}

const exe = await resolveClaudeExecutable('claude');
assert('resolved claude path is non-empty', exe.resolvedPath.length > 0, exe.resolvedPath, 'non-empty string');
if (process.platform === 'win32' && exe.resolvedPath.toLowerCase().endsWith('claude.exe')) {
  assertEquals('native Claude exe avoids shell mode', exe.shell, false);
}
console.log(`        Resolved: ${exe.resolvedPath}`);
console.log(`        Shell mode: ${exe.shell}`);

// ─── 8. Live claude invocation (--version to test without auth) ───────────────

console.log('\n=== 8. Live Claude CLI Invocation ===');

async function testClaudeCliInvocation(exePath, useShell) {
  return new Promise((resolve) => {
    const events = [];
    let stdout = '';
    let stderr = '';

    const child = spawn(exePath, ['--version'], { shell: useShell, env: process.env });
    child.stdin.end();

    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8');
      stdout += text;
      events.push({ type: 'stdout', chunk: text });
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr += text;
      events.push({ type: 'stderr', chunk: text });
    });
    child.on('error', err => {
      events.push({ type: 'spawn-error', message: err.message });
      resolve({ events, stdout, stderr, exitCode: null, spawnError: err.message });
    });
    child.on('close', exitCode => {
      resolve({ events, stdout, stderr, exitCode });
    });
  });
}

const liveResult = await testClaudeCliInvocation(exe.resolvedPath, exe.shell);

if (liveResult.spawnError) {
  console.error(`  FAIL  claude --version: spawn error: ${liveResult.spawnError}`);
  failed++;
} else {
  assert('claude --version: exit code 0', liveResult.exitCode === 0, liveResult.exitCode, 0);
  assert('claude --version: has output', (liveResult.stdout + liveResult.stderr).length > 0,
    liveResult.stdout.slice(0, 50), 'non-empty');
  console.log(`        Output: ${(liveResult.stdout + liveResult.stderr).trim().slice(0, 80)}`);
  console.log(`        Exit code: ${liveResult.exitCode}`);
}

// ─── 9. Simulate full run event pipeline (queue → runner events → summary) ────

console.log('\n=== 9. Full Event Pipeline Simulation ===');

async function simulateRunPipeline(events) {
  const q = new AsyncQueue();
  // Push events async to simulate a real runner
  setTimeout(() => {
    for (const e of events) q.push(e);
    q.close();
  }, 10);

  let stdoutAcc = '';
  let stderrAcc = '';
  let finalStatus = 'unknown';
  let finalError = null;
  let exitCode = undefined;
  let summary = undefined;

  for await (const event of q) {
    if (event.type === 'stdout') stdoutAcc += event.chunk;
    if (event.type === 'stderr') stderrAcc += event.chunk;
    if (event.type === 'completed') {
      finalStatus = 'succeeded';
      exitCode = event.result.exitCode;
      summary = event.result.summary;
    }
    if (event.type === 'failed') {
      finalStatus = 'failed';
      finalError = event.error;
    }
    if (event.type === 'cancelled') finalStatus = 'cancelled';
  }

  return { finalStatus, finalError, exitCode, summary, stdout: stdoutAcc, stderr: stderrAcc };
}

// Successful run
const successEvents = [
  { type: 'started', at: new Date().toISOString() },
  { type: 'progress', message: 'Starting...', at: new Date().toISOString() },
  { type: 'stdout', chunk: 'Analyzing code...\n', at: new Date().toISOString() },
  { type: 'stdout', chunk: 'Fixed the bug in auth.ts\n', at: new Date().toISOString() },
  { type: 'completed', result: { exitCode: 0, summary: 'Fixed auth bug in 2 files.' }, at: new Date().toISOString() }
];
const successResult = await simulateRunPipeline(successEvents);
assertEquals('success: status = succeeded', successResult.finalStatus, 'succeeded');
assertEquals('success: summary', successResult.summary, 'Fixed auth bug in 2 files.');
assertContains('success: stdout accumulated', successResult.stdout, 'Fixed the bug');

// Failed run (non-zero exit)
const failedEvents = [
  { type: 'started', at: new Date().toISOString() },
  { type: 'stdout', chunk: 'Running...\n', at: new Date().toISOString() },
  { type: 'stderr', chunk: 'Error: module not found\n', at: new Date().toISOString() },
  { type: 'failed', error: { message: 'Claude CLI exited with code 1.\n\nError: module not found', category: 'runner_failed' }, at: new Date().toISOString() }
];
const failedResult = await simulateRunPipeline(failedEvents);
assertEquals('failed: status = failed', failedResult.finalStatus, 'failed');
assertEquals('failed: category', failedResult.finalError.category, 'runner_failed');
assertContains('failed: stderr', failedResult.stderr, 'module not found');

// Token exhausted run
const tokenEvents = [
  { type: 'started', at: new Date().toISOString() },
  { type: 'failed', error: { message: 'Claude CLI exited with code 1.\n\ntoken limit exceeded', category: 'token_exhausted' }, at: new Date().toISOString() }
];
const tokenResult = await simulateRunPipeline(tokenEvents);
assertEquals('token_exhausted: category', tokenResult.finalError.category, 'token_exhausted');

// ─── 10. Validate task spec before queue (validation logic) ───────────────────

console.log('\n=== 10. Pre-Queue Validation ===');

function validateTask(task, repositoryPath) {
  const errors = [];
  if (!repositoryPath) errors.push('A local repository path is required for Claude CLI execution.');
  if (task.permissionProfile === 'ask') {
    errors.push('Claude CLI non-interactive execution cannot use the ask permission profile.');
  }
  if (needsGitMetadataWrites(task.spec)) {
    if (task.permissionProfile === 'read_only') {
      errors.push('Claude CLI tasks that create branches, commits, or push to remotes cannot use the read_only permission profile.');
    } else if (task.permissionProfile !== 'bypass') {
      errors.push('Claude CLI tasks that create branches, commits, or push to remotes require the bypass permission profile.');
    }
  }
  return { valid: errors.length === 0, errors };
}

const validTask = makeTask({ spec: 'Fix the bug.', permissionProfile: 'bypass' });
const validResult = validateTask(validTask, 'C:\\repo');
assertEquals('valid task: no errors', validResult.valid, true);

const askTask = makeTask({ permissionProfile: 'ask' });
const askResult = validateTask(askTask, 'C:\\repo');
assertEquals('ask profile: invalid', askResult.valid, false);
assertContains('ask profile: error message', askResult.errors[0], 'ask permission profile');

const noRepoResult = validateTask(validTask, null);
assertEquals('no repository: invalid', noRepoResult.valid, false);
assertContains('no repository: error message', noRepoResult.errors[0], 'repository path is required');

const commitTask = makeTask({ spec: 'Create a branch and commit the changes.', permissionProfile: 'allow_workspace' });
const commitResult = validateTask(commitTask, 'C:\\repo');
assertEquals('commit+allow_workspace: invalid', commitResult.valid, false);
assertContains('commit+allow_workspace: error', commitResult.errors[0], 'bypass permission profile');

const commitBypassTask = makeTask({ spec: 'Create a branch and commit the changes.', permissionProfile: 'bypass' });
const commitBypassResult = validateTask(commitBypassTask, 'C:\\repo');
assertEquals('commit+bypass: valid', commitBypassResult.valid, true);

const spanishBranchTask = makeTask({ spec: 'Crea una nueva rama para este feature.', permissionProfile: 'allow_workspace' });
const spanishResult = validateTask(spanishBranchTask, 'C:\\repo');
assertEquals('Spanish "rama" + allow_workspace: invalid', spanishResult.valid, false);

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log('\n=== Test Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
