import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { resolveCodexExecutable } from './executable';

const execFileAsync = promisify(execFile);

export interface CodexReadinessReport {
  okForCli: boolean;
  okForCloud: boolean;
  markdown: string;
}

export async function checkCodexEnvironment(repositoryPath?: string): Promise<CodexReadinessReport> {
  const config = vscode.workspace.getConfiguration('agenticKanbasutra');
  const configuredExecutable = config.get<string>('runners.codexCli.executable', 'codex');
  const executable = await resolveCodexExecutable(configuredExecutable);
  const environmentId = config.get<string>('runners.codexCloud.environmentId', '');
  const version = await runCheck(executable, ['--version']);
  const doctor = await runCheck(executable, ['doctor', '--summary', '--ascii']);
  const cloud = environmentId.trim()
    ? await runCheck(executable, ['cloud', 'list', '--env', environmentId, '--limit', '1', '--json'])
    : { ok: false, error: 'No Codex Cloud environment ID configured.' };

  const doctorOutput = doctor.output || doctor.error || '';
  const doctorAuthOk = hasDoctorOk(doctorOutput, 'auth');
  const doctorConfigOk = hasDoctorOk(doctorOutput, 'config');
  const doctorConnectivityOk = hasDoctorOk(doctorOutput, 'websocket') || hasDoctorOk(doctorOutput, 'reachability');
  const doctorUsable = doctor.ok || (doctorAuthOk && doctorConfigOk);
  const okForCli = version.ok && (!doctorOutput || doctorUsable);
  const okForCloud = version.ok && cloud.ok && Boolean(environmentId.trim());

  const markdown = [
    '# AgenticKanbasutra Codex Readiness',
    '',
    `Repository path: ${repositoryPath ?? 'not resolved'}`,
    '',
    '## Summary',
    '',
    `- Codex CLI runner: ${okForCli ? 'ready' : 'not ready'}`,
    `- Codex auth/config: ${doctorAuthOk || doctor.ok ? 'configured' : 'not confirmed'}`,
    `- Codex connectivity: ${doctorConnectivityOk ? 'reachable' : 'not confirmed'}`,
    `- Codex Cloud runner: ${okForCloud ? 'ready' : 'not ready'}`,
    '',
    '## Codex CLI',
    '',
    `Resolved executable: \`${executable}\`.`,
    configuredExecutable !== executable ? `Configured executable: \`${configuredExecutable}\`.` : undefined,
    '',
    version.ok ? 'Status: available.' : 'Status: not available.',
    '',
    fenced(version.output || version.error || 'No output.'),
    '',
    '## Codex Doctor',
    '',
    doctor.ok
      ? 'Status: diagnostic completed.'
      : doctorUsable
        ? 'Status: diagnostic completed with warnings that do not block local Codex CLI use.'
        : 'Status: diagnostic failed or unavailable.',
    '',
    fenced(doctor.output || doctor.error || 'No output.'),
    '',
    '## Codex Cloud',
    '',
    `Configured environment ID: ${environmentId || 'not configured'}`,
    '',
    cloud.ok ? 'Status: cloud list succeeded.' : 'Status: cloud unavailable or not configured.',
    '',
    fenced(cloud.output || cloud.error || 'No output.'),
    '',
    '## Reference Commands',
    '',
    `- Check Codex CLI installation: \`${executable} --version\`.`,
    `- Run Codex local diagnostics: \`${executable} doctor\`.`,
    `- Run a compact Codex diagnostic report: \`${executable} doctor --summary --ascii\`.`,
    `- Start Codex authentication setup: \`${executable} login\`.`,
    environmentId.trim()
      ? `- Check Codex Cloud tasks: \`${executable} cloud list --env ${environmentId} --limit 1 --json\`.`
      : '- Configure Codex Cloud before checking tasks: set `agenticKanbasutra.runners.codexCloud.environmentId`.',
    '',
    '## Recommended Flow',
    '',
    '1. Use `codex-cli` for local non-interactive execution.',
    '2. Use `codex-cloud` after configuring `agenticKanbasutra.runners.codexCloud.environmentId`.',
    '3. Use `codex-manual` when you want to run the task in the Codex IDE panel or sidebar.'
  ].filter((line): line is string => line !== undefined).join('\n');

  return { okForCli, okForCloud, markdown };
}

async function runCheck(command: string, args: string[]): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024, timeout: 20000 });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
  } catch (error) {
    const anyError = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    return {
      ok: false,
      error: [
        anyError.stdout,
        anyError.stderr,
        anyError.killed ? 'Command timed out after 20 seconds.' : undefined,
        anyError.message
      ].filter(Boolean).join('\n').trim()
    };
  }
}

function hasDoctorOk(output: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[(?:ok|OK)\\]\\s+${escaped}\\b`, 'i').test(output)
    || new RegExp(`✓\\s+${escaped}\\b`, 'i').test(output);
}

function fenced(value: string): string {
  return ['```text', value.trim(), '```'].join('\n');
}
