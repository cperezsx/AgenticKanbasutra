import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ProviderUsageSnapshot, ProviderUsageWindow, RunRecord } from '../domain/types';
import { resolveCodexExecutable } from '../runners/codex/executable';
import { resolveClaudeExecutable } from '../runners/claude/executable';
import { JsonStore } from '../storage/jsonStore';

const execFileAsync = promisify(execFile);
const providerIds: ProviderUsageSnapshot['providerId'][] = ['codex', 'claude', 'copilot'];
const usageCacheMs = 5 * 60 * 1000;
const observedFailureMs = 24 * 60 * 60 * 1000;

interface PersistedProviderUsage {
  snapshots: ProviderUsageSnapshot[];
}

interface UsageCommand {
  command: string;
  args: string[];
  shell?: boolean;
  source: ProviderUsageSnapshot['source'];
  parse: (providerId: 'codex' | 'claude', output: string, source: ProviderUsageSnapshot['source']) => ProviderUsageSnapshot;
  parseOnFailure?: boolean;
  continueOnUnavailable?: boolean;
}

interface CodexRateLimitInfo {
  checkedAt: string;
  planType?: string;
  allowed?: boolean;
  limitReached?: boolean;
  windows: ProviderUsageWindow[];
}

export class ProviderUsageService {
  private readonly store: JsonStore<PersistedProviderUsage>;

  constructor(rootPath: string) {
    this.store = new JsonStore<PersistedProviderUsage>(path.join(rootPath, 'state', 'providerUsage.json'), {
      snapshots: []
    });
  }

  async getSnapshots(runs: RunRecord[]): Promise<ProviderUsageSnapshot[]> {
    const persisted = await this.store.read();
    const byProvider = new Map<ProviderUsageSnapshot['providerId'], ProviderUsageSnapshot>();
    for (const providerId of providerIds) {
      byProvider.set(providerId, unknownSnapshot(providerId));
    }
    for (const snapshot of persisted.snapshots) {
      byProvider.set(snapshot.providerId, snapshot);
    }
    for (const observed of observedSnapshotsFromRuns(runs)) {
      const current = byProvider.get(observed.providerId);
      if (!current || shouldReplaceWithObserved(current, observed)) {
        byProvider.set(observed.providerId, observed);
      }
    }
    return providerIds.map((providerId) => byProvider.get(providerId) ?? unknownSnapshot(providerId));
  }

  async preflight(
    providerId: ProviderUsageSnapshot['providerId'],
    runs: RunRecord[]
  ): Promise<ProviderUsageSnapshot> {
    const current = (await this.getSnapshots(runs)).find((snapshot) => snapshot.providerId === providerId)
      ?? unknownSnapshot(providerId);

    if (providerId === 'copilot') {
      return current;
    }

    if ((current.confidence === 'direct' || current.confidence === 'unavailable') && isFresh(current)) {
      return current;
    }

    const checked = providerId === 'codex'
      ? await this.checkCodex(false)
      : await this.checkClaude(false);

    if (checked.status === 'unknown' && current.status === 'blocked' && current.confidence === 'observed') {
      return current;
    }
    return checked;
  }

  async refreshAll(): Promise<ProviderUsageSnapshot[]> {
    return Promise.all([
      this.checkCodex(true),
      this.checkClaude(true),
      this.markCopilotManualOpen()
    ]);
  }

  async checkCodex(force = true): Promise<ProviderUsageSnapshot> {
    const current = await this.currentSnapshot('codex');
    if (!force && isFresh(current)) {
      return current;
    }
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    const executable = await resolveCodexExecutable(config.get<string>('runners.codexCli.executable', 'codex'));
    const snapshot = await checkCliUsage('codex', [
      { command: executable, args: ['doctor', '--json'], source: 'codex-doctor', parse: parseCodexDoctor, parseOnFailure: true },
      { command: executable, args: ['doctor', '--summary', '--ascii', '--no-color'], source: 'codex-doctor', parse: parseCodexDoctor, parseOnFailure: true }
    ]);
    const enriched = enrichCodexSnapshot(snapshot, await readLatestCodexRateLimits());
    await this.upsert(enriched);
    return enriched;
  }

  async checkClaude(force = true): Promise<ProviderUsageSnapshot> {
    const current = await this.currentSnapshot('claude');
    if (!force && isFresh(current)) {
      return current;
    }
    const config = vscode.workspace.getConfiguration('agenticKanbasutra');
    const executable = await resolveClaudeExecutable(config.get<string>('runners.claudeCli.executable', 'claude'));
    const snapshot = await checkCliUsage('claude', [
      { command: executable.command, args: [...executable.argsPrefix, '-p', '/usage', '--output-format', 'json', '--no-session-persistence'], shell: executable.shell, source: 'claude-usage', parse: parseClaudeUsageCommand, parseOnFailure: true, continueOnUnavailable: true },
      { command: executable.command, args: [...executable.argsPrefix, 'auth', 'status'], shell: executable.shell, source: 'claude-auth-status', parse: parseClaudeAuthStatus, parseOnFailure: true },
      { command: executable.command, args: [...executable.argsPrefix, 'auth', 'status', '--text'], shell: executable.shell, source: 'claude-auth-status', parse: parseClaudeAuthStatus, parseOnFailure: true }
    ]);
    await this.upsert(snapshot);
    return snapshot;
  }

  async markCopilotManualOpen(): Promise<ProviderUsageSnapshot> {
    const snapshot: ProviderUsageSnapshot = {
      providerId: 'copilot',
      status: 'unknown',
      confidence: 'manual',
      label: 'View on web',
      checkedAt: new Date().toISOString(),
      source: 'copilot-web',
      rawSummary: 'GitHub Copilot usage is checked on the web for this preview.'
    };
    await this.upsert(snapshot);
    return snapshot;
  }

  private async currentSnapshot(providerId: ProviderUsageSnapshot['providerId']): Promise<ProviderUsageSnapshot> {
    const persisted = await this.store.read();
    return persisted.snapshots.find((snapshot) => snapshot.providerId === providerId) ?? unknownSnapshot(providerId);
  }

  private async upsert(snapshot: ProviderUsageSnapshot): Promise<void> {
    const persisted = await this.store.read();
    const index = persisted.snapshots.findIndex((item) => item.providerId === snapshot.providerId);
    if (index >= 0) {
      persisted.snapshots[index] = snapshot;
    } else {
      persisted.snapshots.push(snapshot);
    }
    await this.store.write(persisted);
  }
}

export function providerIdForRunner(runnerId: string): ProviderUsageSnapshot['providerId'] | undefined {
  if (runnerId.startsWith('codex')) {
    return 'codex';
  }
  if (runnerId.startsWith('claude')) {
    return 'claude';
  }
  if (runnerId.startsWith('copilot')) {
    return 'copilot';
  }
  return undefined;
}

export function parseProviderUsage(
  providerId: ProviderUsageSnapshot['providerId'],
  output: string,
  source: ProviderUsageSnapshot['source']
): ProviderUsageSnapshot {
  const checkedAt = new Date().toISOString();
  const normalized = output.toLowerCase();
  const percentRemaining = extractPercent(output, ['remaining', 'left', 'available']);
  const percentUsed = extractPercent(output, ['used', 'consumed']);
  const derivedRemaining = percentRemaining ?? (percentUsed !== undefined ? Math.max(0, 100 - percentUsed) : undefined);
  const blocked = /\b(limit|quota|rate limit|usage)\b.*\b(reached|exceeded|blocked|exhausted)\b/i.test(output)
    || /\b(reached|exceeded|blocked|exhausted)\b.*\b(limit|quota|rate limit|usage)\b/i.test(output);
  const warning = /\b(low|near|approaching|warning)\b.*\b(limit|quota|usage|capacity)\b/i.test(output);
  const resetAt = extractReset(output);
  const rawSummary = safeSummary(output);

  if (blocked || (derivedRemaining !== undefined && derivedRemaining <= 5)) {
    return {
      providerId,
      status: 'blocked',
      confidence: 'direct',
      label: derivedRemaining !== undefined ? `${derivedRemaining}% left` : 'Limit reached',
      percentRemaining: derivedRemaining,
      percentUsed,
      resetAt,
      checkedAt,
      source,
      rawSummary
    };
  }

  if (warning || (derivedRemaining !== undefined && derivedRemaining <= 25)) {
    return {
      providerId,
      status: 'warning',
      confidence: 'direct',
      label: derivedRemaining !== undefined ? `${derivedRemaining}% left` : 'Check soon',
      percentRemaining: derivedRemaining,
      percentUsed,
      resetAt,
      checkedAt,
      source,
      rawSummary
    };
  }

  if (derivedRemaining !== undefined) {
    return {
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: `${derivedRemaining}% left`,
      percentRemaining: derivedRemaining,
      percentUsed,
      resetAt,
      checkedAt,
      source,
      rawSummary
    };
  }

  if (normalized.trim()) {
    return {
      providerId,
      status: 'unknown',
      confidence: 'direct',
      label: 'Check output',
      resetAt,
      checkedAt,
      source,
      rawSummary
    };
  }

  return {
    providerId,
    status: 'unknown',
    confidence: 'unavailable',
    label: 'No usage data',
    checkedAt,
    source,
    rawSummary: 'The command completed without usage output.'
  };
}

function parseCodexDoctor(
  providerId: 'codex' | 'claude',
  output: string,
  source: ProviderUsageSnapshot['source']
): ProviderUsageSnapshot {
  const checkedAt = new Date().toISOString();
  const rawSummary = safeSummary(output);
  const json = tryParseJson(output) as {
    overallStatus?: string;
    codexVersion?: string;
    checks?: Record<string, { status?: string; summary?: string; category?: string }>;
  } | undefined;

  if (json?.checks) {
    const checks = Object.values(json.checks);
    const failingChecks = checks.filter((check) => isFailStatus(check.status));
    const warningChecks = checks.filter((check) => isWarningStatus(check.status));
    const auth = json.checks['auth.credentials'];
    const config = json.checks['config.load'];
    const websocket = json.checks['network.websocket_reachability'];
    const reachability = json.checks['network.provider_reachability'];
    const blocking = [auth, config, websocket, reachability].filter((check) => check && isFailStatus(check.status));

    if (blocking.length > 0) {
      return {
        providerId,
        status: 'blocked',
        confidence: 'direct',
        label: firstSummary(blocking) ?? 'Codex not ready',
        checkedAt,
        source,
        rawSummary
      };
    }

    if (failingChecks.length > 0 || isFailStatus(json.overallStatus)) {
      return {
        providerId,
        status: 'warning',
        confidence: 'direct',
        label: firstSummary(failingChecks) ?? 'Doctor has failures',
        checkedAt,
        source,
        rawSummary
      };
    }

    return {
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: warningChecks.length > 0 || isWarningStatus(json.overallStatus)
        ? 'Ready'
        : json.codexVersion ? `Ready ${json.codexVersion}` : 'Ready',
      checkedAt,
      source,
      rawSummary
    };
  }

  const normalized = output.toLowerCase();
  const failMatch = /(\d+)\s+fail/i.exec(output);
  const warnMatch = /(\d+)\s+warn/i.exec(output);
  const failCount = failMatch ? Number(failMatch[1]) : 0;
  const warnCount = warnMatch ? Number(warnMatch[1]) : 0;
  if (failCount > 0 || normalized.includes('[fail]')) {
    return {
      providerId,
      status: 'warning',
      confidence: 'direct',
      label: 'Doctor has failures',
      checkedAt,
      source,
      rawSummary
    };
  }
  if (warnCount > 0 || normalized.includes('[!!]') || normalized.includes(' warning')) {
    return {
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: 'Ready',
      checkedAt,
      source,
      rawSummary
    };
  }
  if (normalized.trim()) {
    return {
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: 'Ready',
      checkedAt,
      source,
      rawSummary
    };
  }
  return unavailableSnapshot(providerId, source, 'Doctor unavailable', 'Codex doctor completed without output.');
}

function parseClaudeAuthStatus(
  providerId: 'codex' | 'claude',
  output: string,
  source: ProviderUsageSnapshot['source']
): ProviderUsageSnapshot {
  const checkedAt = new Date().toISOString();
  const rawSummary = safeSummary(output);
  const json = tryParseJson(output) as { authenticated?: boolean; loggedIn?: boolean; status?: string; error?: string; message?: string } | undefined;
  const authenticated = json?.authenticated ?? json?.loggedIn ?? (json?.status ? /^(authenticated|logged.?in|ok)$/i.test(json.status) : undefined);
  if (authenticated === true) {
    return enrichSnapshotWithParsedUsage({
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: 'Auth ready',
      checkedAt,
      source,
      rawSummary
    }, output, source);
  }
  if (authenticated === false || /not\s+(authenticated|logged in)|login required|not logged in/i.test(output)) {
    return {
      providerId,
      status: 'blocked',
      confidence: 'direct',
      label: 'Login required',
      checkedAt,
      source,
      rawSummary
    };
  }
  if (/authenticated|logged in|auth.*ok/i.test(output)) {
    return enrichSnapshotWithParsedUsage({
      providerId,
      status: 'healthy',
      confidence: 'direct',
      label: 'Auth ready',
      checkedAt,
      source,
      rawSummary
    }, output, source);
  }
  if (output.trim()) {
    return {
      providerId,
      status: 'unknown',
      confidence: 'direct',
      label: 'Check auth output',
      checkedAt,
      source,
      rawSummary
    };
  }
  return unavailableSnapshot(providerId, source, 'Auth unavailable', 'Claude auth status completed without output.');
}

function parseClaudeUsageCommand(
  providerId: 'codex' | 'claude',
  output: string,
  source: ProviderUsageSnapshot['source']
): ProviderUsageSnapshot {
  const checkedAt = new Date().toISOString();
  const json = tryParseJsonObject(output.trim()) as { result?: string; is_error?: boolean; subtype?: string } | undefined;
  const usageText = typeof json?.result === 'string'
    ? json.result
    : extractClaudeUsageText(output) ?? output;
  const rawSummary = safeSummary(usageText);
  const windows = parseClaudeUsageWindows(usageText, checkedAt);

  if (windows.length === 0) {
    if (json?.is_error === true || /login required|not\s+(authenticated|logged in)|not logged in/i.test(usageText)) {
      return {
        providerId,
        status: 'blocked',
        confidence: 'direct',
        label: 'Login required',
        checkedAt,
        source,
        rawSummary
      };
    }
    return unavailableSnapshot(providerId, source, 'Usage unavailable', rawSummary || 'Claude usage completed without usage details.');
  }

  const primary = windows.find((window) => window.id === 'current-session') ?? windows[0];
  const percentRemaining = primary.percentRemaining;
  const status = percentRemaining !== undefined && percentRemaining <= 5
    ? 'blocked'
    : percentRemaining !== undefined && percentRemaining <= 25
      ? 'warning'
      : 'healthy';
  const label = claudeUsageLabel(primary, windows);

  return {
    providerId,
    status,
    confidence: 'direct',
    label,
    percentRemaining,
    percentUsed: primary.percentUsed,
    resetAt: primary.resetAt,
    usageWindows: windows,
    checkedAt,
    source,
    rawSummary
  };
}

function claudeUsageLabel(primary: ProviderUsageWindow, windows: ProviderUsageWindow[]): string {
  const parts: string[] = [];
  if (primary.percentRemaining !== undefined) {
    const primaryName = primary.id === 'current-session' ? 'session' : primary.label.toLowerCase();
    parts.push(`${primary.percentRemaining}% left ${primaryName}`);
  } else {
    parts.push('Usage available');
  }
  const reset = primary.resetAt ? formatDuration(secondsUntil(primary.resetAt)) : undefined;
  if (reset) {
    parts.push(`resets in ${reset}`);
  }
  const week = windows.find((window) => window.id.includes('week'));
  if (week?.percentRemaining !== undefined) {
    parts.push(`week ${week.percentRemaining}% left`);
  }
  return parts.join(' · ');
}

function extractClaudeUsageText(output: string): string | undefined {
  const marker = 'You are currently using your subscription to power your Claude Code usage';
  const markerIndex = output.indexOf(marker);
  if (markerIndex >= 0) {
    return output.slice(markerIndex).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (/Current session:\s*\d{1,3}\s*%\s*used/i.test(output)) {
    return output.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return undefined;
}

function parseClaudeUsageWindows(output: string, checkedAt: string): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = /^([^:]+):\s*(\d{1,3})\s*%\s*used(?:\s*[·-]\s*resets?\s+(.+))?$/i.exec(line);
    const parsedMatch = match ?? /^([^:]+):\s*(\d{1,3})\s*%\s*used(?:\s*(?:[^A-Za-z0-9\s]\s*)?resets?\s+(.+))?$/i.exec(line);
    if (!parsedMatch) {
      continue;
    }
    const label = normalizeClaudeUsageLabel(parsedMatch[1]);
    const percentUsed = clampPercent(Number(parsedMatch[2]));
    const resetAt = parseClaudeResetAt(parsedMatch[3], checkedAt);
    windows.push({
      id: slugifyUsageWindow(label),
      label,
      percentUsed,
      percentRemaining: clampPercent(100 - percentUsed),
      resetAt,
      resetAfterSeconds: resetAt ? secondsUntil(resetAt) : undefined
    });
  }
  return windows;
}

function normalizeClaudeUsageLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function slugifyUsageWindow(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'usage-window';
}

function parseClaudeResetAt(value: string | undefined, checkedAt: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/\([^)]*\)/g, '').trim();
  const direct = new Date(cleaned).getTime();
  if (Number.isFinite(direct)) {
    return new Date(direct).toISOString();
  }

  const reference = new Date(checkedAt);
  const year = Number.isFinite(reference.getTime()) ? reference.getFullYear() : new Date().getFullYear();
  const relativeMatch = /^(today|tomorrow),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(cleaned);
  if (relativeMatch) {
    const date = new Date(reference);
    if (/tomorrow/i.test(relativeMatch[1])) {
      date.setDate(date.getDate() + 1);
    }
    date.setHours(to24Hour(Number(relativeMatch[2]), relativeMatch[4]), Number(relativeMatch[3] ?? 0), 0, 0);
    return date.toISOString();
  }

  const monthMatch = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(cleaned);
  if (!monthMatch) {
    return undefined;
  }
  const month = monthIndex(monthMatch[1]);
  if (month === undefined) {
    return undefined;
  }
  let candidate = new Date(year, month, Number(monthMatch[2]), to24Hour(Number(monthMatch[3]), monthMatch[5]), Number(monthMatch[4] ?? 0), 0, 0);
  const referenceTime = Number.isFinite(reference.getTime()) ? reference.getTime() : Date.now();
  if (candidate.getTime() < referenceTime - 60 * 60 * 1000) {
    candidate = new Date(year + 1, month, Number(monthMatch[2]), to24Hour(Number(monthMatch[3]), monthMatch[5]), Number(monthMatch[4] ?? 0), 0, 0);
  }
  return candidate.toISOString();
}

function to24Hour(hour: number, meridiem: string): number {
  const normalized = hour % 12;
  return /pm/i.test(meridiem) ? normalized + 12 : normalized;
}

function monthIndex(value: string): number | undefined {
  const normalized = value.slice(0, 3).toLowerCase();
  const index = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(normalized);
  return index >= 0 ? index : undefined;
}

function enrichSnapshotWithParsedUsage(
  snapshot: ProviderUsageSnapshot,
  output: string,
  source: ProviderUsageSnapshot['source']
): ProviderUsageSnapshot {
  const parsed = parseProviderUsage(snapshot.providerId, output, source);
  const hasUsageDetail = parsed.percentRemaining !== undefined
    || parsed.percentUsed !== undefined
    || parsed.resetAt !== undefined
    || parsed.usageWindows?.length;
  if (!hasUsageDetail) {
    return snapshot;
  }

  const reset = parsed.resetAt ? ` - ${parsed.resetAt}` : '';
  return {
    ...snapshot,
    status: snapshot.status === 'blocked' ? snapshot.status : parsed.status === 'unknown' ? snapshot.status : parsed.status,
    label: parsed.percentRemaining !== undefined
      ? `${parsed.percentRemaining}% left${reset}`
      : snapshot.label,
    percentRemaining: parsed.percentRemaining ?? snapshot.percentRemaining,
    percentUsed: parsed.percentUsed ?? snapshot.percentUsed,
    resetAt: parsed.resetAt ?? snapshot.resetAt,
    usageWindows: parsed.usageWindows ?? snapshot.usageWindows,
    rawSummary: [snapshot.rawSummary, parsed.rawSummary]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join('\n\n')
  };
}

function observedSnapshotsFromRuns(runs: RunRecord[]): ProviderUsageSnapshot[] {
  const snapshots: ProviderUsageSnapshot[] = [];
  const sorted = [...runs].sort((a, b) => String(b.completedAt ?? b.startedAt).localeCompare(String(a.completedAt ?? a.startedAt)));
  for (const run of sorted) {
    const providerId = providerIdForRunner(run.runnerId);
    if (!providerId || !run.error) {
      continue;
    }
    if (!['token_exhausted', 'quota_exhausted'].includes(run.error.category)) {
      continue;
    }
    if (!isRecent(run.completedAt ?? run.startedAt, observedFailureMs)) {
      continue;
    }
    if (snapshots.some((snapshot) => snapshot.providerId === providerId)) {
      continue;
    }
    snapshots.push({
      providerId,
      status: 'blocked',
      confidence: 'observed',
      label: run.error.category === 'quota_exhausted' ? 'Quota failed' : 'Token failed',
      checkedAt: run.completedAt ?? run.startedAt,
      source: 'runner-failure',
      rawSummary: safeSummary(run.error.message),
      error: run.error.message
    });
  }
  return snapshots;
}

function shouldReplaceWithObserved(current: ProviderUsageSnapshot, observed: ProviderUsageSnapshot): boolean {
  if (current.status === 'blocked' && current.confidence === 'direct' && isFresh(current)) {
    return false;
  }
  if (current.status === 'unknown' && current.confidence === 'unavailable') {
    return true;
  }
  if (!current.checkedAt) {
    return true;
  }
  return new Date(observed.checkedAt ?? 0).getTime() > new Date(current.checkedAt).getTime();
}

function enrichCodexSnapshot(snapshot: ProviderUsageSnapshot, rateLimits: CodexRateLimitInfo | undefined): ProviderUsageSnapshot {
  if (!rateLimits || rateLimits.windows.length === 0) {
    return snapshot;
  }

  const primary = rateLimits.windows.find((window) => window.id === 'primary') ?? rateLimits.windows[0];
  const resetIsCurrent = primary?.resetAt ? new Date(primary.resetAt).getTime() > Date.now() : false;
  const windows = resetIsCurrent ? currentUsageWindows(rateLimits.windows) : rateLimits.windows;
  const currentPrimary = windows.find((window) => window.id === primary?.id) ?? windows[0];
  const summary = summarizeCodexRateLimits({ ...rateLimits, windows }, resetIsCurrent);
  const percentRemaining = resetIsCurrent ? primary.percentRemaining : undefined;
  const percentUsed = resetIsCurrent ? primary.percentUsed : undefined;
  const limitReached = rateLimits.limitReached === true || rateLimits.allowed === false;
  const rateStatus = limitReached || (percentRemaining !== undefined && percentRemaining <= 5)
    ? 'blocked'
    : percentRemaining !== undefined && percentRemaining <= 25
      ? 'warning'
      : snapshot.status;

  return {
    ...snapshot,
    status: snapshot.status === 'blocked' ? snapshot.status : rateStatus,
    label: resetIsCurrent && currentPrimary
      ? `${currentPrimary.percentRemaining}% left - ${formatDuration(currentPrimary.resetAfterSeconds)} reset`
      : snapshot.label,
    percentRemaining: percentRemaining ?? snapshot.percentRemaining,
    percentUsed: percentUsed ?? snapshot.percentUsed,
    resetAt: resetIsCurrent ? primary.resetAt : snapshot.resetAt,
    checkedAt: resetIsCurrent ? rateLimits.checkedAt : snapshot.checkedAt,
    source: resetIsCurrent ? 'codex-status' : snapshot.source,
    usageWindows: resetIsCurrent ? windows : snapshot.usageWindows,
    rawSummary: [snapshot.rawSummary, resetIsCurrent ? summary : `Last Codex rate-limit event is stale. ${summary}`]
      .filter(Boolean)
      .join('\n\n')
  };
}

function currentUsageWindows(windows: ProviderUsageWindow[]): ProviderUsageWindow[] {
  return windows.map((window) => ({
    ...window,
    resetAfterSeconds: window.resetAt ? secondsUntil(window.resetAt) : window.resetAfterSeconds
  }));
}

async function readLatestCodexRateLimits(): Promise<CodexRateLimitInfo | undefined> {
  const codexHome = codexHomePath();
  if (!codexHome) {
    return undefined;
  }
  const dbPath = path.join(codexHome, 'logs_2.sqlite');
  try {
    await fs.access(dbPath);
  } catch {
    return undefined;
  }

  for (const candidate of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(candidate.command, [...candidate.args, '-c', codexRateLimitReaderScript, dbPath], {
        maxBuffer: 1024 * 64,
        timeout: 3000
      });
      const parsed = tryParseJson(stdout.trim()) as CodexRateLimitInfo | undefined;
      if (parsed?.windows?.length) {
        return parsed;
      }
    } catch {
      // Best effort only. Codex doctor remains the readiness check.
    }
  }
  return undefined;
}

function codexHomePath(): string | undefined {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) {
    return configured;
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, '.codex') : undefined;
}

function pythonCandidates(): Array<{ command: string; args: string[] }> {
  return process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
}

const codexRateLimitReaderScript = String.raw`
import datetime, json, sqlite3, sys
db_path = sys.argv[1]
con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
rows = con.execute("""
    select ts, feedback_log_body
    from logs
    where feedback_log_body like '%"type":"codex.rate_limits"%'
    order by id desc
    limit 30
""").fetchall()
con.close()
decoder = json.JSONDecoder()
for ts, body in rows:
    if not body:
        continue
    marker = '"type":"codex.rate_limits"'
    marker_index = body.find(marker)
    if marker_index < 0:
        continue
    start = body.rfind('{', 0, marker_index)
    if start < 0:
        continue
    try:
        event, _ = decoder.raw_decode(body[start:])
    except Exception:
        continue
    limits = event.get('rate_limits') or {}
    windows = []
    for key, label in [('primary', 'Primary'), ('secondary', 'Secondary')]:
        item = limits.get(key) or {}
        used = item.get('used_percent')
        reset_at = item.get('reset_at')
        reset_after = item.get('reset_after_seconds')
        windows.append({
            'id': key,
            'label': label,
            'percentUsed': used,
            'percentRemaining': None if used is None else max(0, min(100, 100 - int(used))),
            'windowMinutes': item.get('window_minutes'),
            'resetAt': None if reset_at is None else datetime.datetime.fromtimestamp(int(reset_at), tz=datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
            'resetAfterSeconds': reset_after
        })
    print(json.dumps({
        'checkedAt': datetime.datetime.fromtimestamp(int(ts), tz=datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'planType': event.get('plan_type'),
        'allowed': limits.get('allowed'),
        'limitReached': limits.get('limit_reached'),
        'windows': [w for w in windows if w.get('percentUsed') is not None or w.get('resetAt')]
    }))
    break
`;

function summarizeCodexRateLimits(rateLimits: CodexRateLimitInfo, current: boolean): string {
  const plan = rateLimits.planType ? `Codex plan: ${rateLimits.planType}.` : undefined;
  const allowed = rateLimits.allowed !== undefined
    ? `Allowed: ${rateLimits.allowed ? 'yes' : 'no'}.`
    : undefined;
  const windows = rateLimits.windows.map((window) => {
    const used = window.percentUsed !== undefined ? `${window.percentUsed}% used` : 'usage unknown';
    const remaining = window.percentRemaining !== undefined ? `${window.percentRemaining}% left` : 'remaining unknown';
    const reset = current && window.resetAfterSeconds !== undefined
      ? `resets in ${formatDuration(window.resetAfterSeconds)}`
      : window.resetAt ? `resets at ${window.resetAt}` : 'reset unknown';
    const duration = window.windowMinutes ? `${formatDuration(window.windowMinutes * 60)} window` : 'window unknown';
    return `${window.label}: ${used}, ${remaining}, ${reset}, ${duration}.`;
  });
  return [plan, allowed, ...windows].filter(Boolean).join('\n');
}

function secondsUntil(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

function formatDuration(totalSeconds: number | undefined): string {
  if (totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

async function checkCliUsage(providerId: 'codex' | 'claude', commands: UsageCommand[]): Promise<ProviderUsageSnapshot> {
  const errors: string[] = [];
  for (const command of commands) {
    const result = await runUsageCommand(command);
    if (result.ok) {
      const snapshot = command.parse(providerId, result.output ?? '', command.source);
      if (command.continueOnUnavailable && snapshot.confidence === 'unavailable' && snapshot.status === 'unknown') {
        errors.push(snapshot.rawSummary ?? 'Usage command returned no usable data.');
        continue;
      }
      return snapshot;
    }
    if (command.parseOnFailure && result.output?.trim()) {
      const snapshot = command.parse(providerId, result.output, command.source);
      if (command.continueOnUnavailable && snapshot.confidence === 'unavailable' && snapshot.status === 'unknown') {
        errors.push(snapshot.rawSummary ?? result.error ?? 'Usage command returned no usable data.');
        continue;
      }
      return snapshot;
    }
    errors.push(result.error ?? 'Usage command failed.');
  }
  return {
    providerId,
    status: 'unknown',
    confidence: 'unavailable',
    label: providerId === 'codex' ? 'Doctor unavailable' : 'Auth unavailable',
    checkedAt: new Date().toISOString(),
    source: commands[0]?.source ?? 'manual',
    rawSummary: safeSummary(errors.join('\n\n')),
    error: errors[0]
  };
}

async function runUsageCommand(command: UsageCommand): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      maxBuffer: 1024 * 256,
      timeout: 10000,
      shell: command.shell ?? false
    });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
  } catch (error) {
    const anyError = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = [anyError.stdout, anyError.stderr].filter(Boolean).join('\n').trim();
    return {
      ok: false,
      output,
      error: [
        output,
        anyError.killed ? 'Command timed out after 10 seconds.' : undefined,
        anyError.message
      ].filter(Boolean).join('\n').trim()
    };
  }
}

function extractPercent(output: string, words: string[]): number | undefined {
  for (const word of words) {
    const before = new RegExp(`(\\d{1,3})\\s*%\\s*(?:${word})`, 'i').exec(output);
    if (before) {
      return clampPercent(Number(before[1]));
    }
    const after = new RegExp(`(?:${word})\\D{0,24}(\\d{1,3})\\s*%`, 'i').exec(output);
    if (after) {
      return clampPercent(Number(after[1]));
    }
  }
  return undefined;
}

function extractReset(output: string): string | undefined {
  const match = /\breset(?:s|ting)?(?:\s+at|\s+in|:)?\s+([^\n\r.;]+)/i.exec(output);
  return match?.[1]?.trim().slice(0, 80);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isFresh(snapshot: ProviderUsageSnapshot): boolean {
  return isRecent(snapshot.checkedAt, usageCacheMs);
}

function isRecent(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) {
    return false;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function tryParseJsonObject(value: string): unknown | undefined {
  const direct = tryParseJson(value);
  if (direct !== undefined) {
    return direct;
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParseJson(value.slice(start, end + 1));
  }
  return undefined;
}

function isFailStatus(status: string | undefined): boolean {
  return /^(fail|failed|error|blocked|degraded)$/i.test(status ?? '');
}

function isWarningStatus(status: string | undefined): boolean {
  return /^(warn|warning)$/i.test(status ?? '');
}

function firstSummary(checks: Array<{ summary?: string } | undefined>): string | undefined {
  return checks.find((check) => check?.summary)?.summary;
}

function unavailableSnapshot(
  providerId: ProviderUsageSnapshot['providerId'],
  source: ProviderUsageSnapshot['source'],
  label: string,
  rawSummary: string
): ProviderUsageSnapshot {
  return {
    providerId,
    status: 'unknown',
    confidence: 'unavailable',
    label,
    checkedAt: new Date().toISOString(),
    source,
    rawSummary
  };
}

function unknownSnapshot(providerId: ProviderUsageSnapshot['providerId']): ProviderUsageSnapshot {
  return {
    providerId,
    status: 'unknown',
    confidence: providerId === 'copilot' ? 'manual' : 'unavailable',
    label: providerId === 'copilot' ? 'View on web' : 'Not checked',
    source: providerId === 'copilot' ? 'copilot-web' : 'manual',
    rawSummary: providerId === 'copilot'
      ? 'GitHub Copilot usage is checked on the web for this preview.'
      : 'Usage has not been checked yet.'
  };
}

function safeSummary(value: string): string {
  return value
    .replace(/\b(?:sk|gh[pousr]|github_pat|xox[baprs])_[A-Za-z0-9_=-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()
    .slice(0, 700);
}
