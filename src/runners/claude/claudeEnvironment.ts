import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { resolveClaudeExecutable } from './executable';

const execFileAsync = promisify(execFile);

export interface ClaudeReadinessReport {
  okForCli: boolean;
  markdown: string;
}

export async function checkClaudeEnvironment(repositoryPath?: string): Promise<ClaudeReadinessReport> {
  const config = vscode.workspace.getConfiguration('agenticKanbasutra');
  const configuredExecutable = config.get<string>('runners.claudeCli.executable', 'claude');
  const executable = await resolveClaudeExecutable(configuredExecutable);
  const version = await runCheck(executable.command, [...executable.argsPrefix, '--version'], executable.shell);
  const okForCli = version.ok;

  const markdown = [
    '# AgenticKanbasutra Claude Readiness',
    '',
    `Repository path: ${repositoryPath ?? 'not resolved'}`,
    '',
    '## Summary',
    '',
    `- Claude CLI runner: ${okForCli ? 'available' : 'not available'}`,
    '- Claude authentication: not checked without starting a Claude Code session.',
    '',
    '## Claude CLI',
    '',
    `Resolved executable: \`${executable.resolvedPath}\`.`,
    executable.configuredExecutable !== executable.resolvedPath ? `Configured executable: \`${executable.configuredExecutable}\`.` : undefined,
    '',
    version.ok ? 'Status: available.' : 'Status: not available.',
    '',
    fenced(version.output || version.error || 'No output.'),
    '',
    '## Reference Commands',
    '',
    `- Check Claude CLI installation: \`${executable.resolvedPath} --version\`.`,
    `- Run a non-interactive smoke task: \`${executable.resolvedPath} -p --output-format json "Say ready."\`.`,
    '',
    '## Recommended Flow',
    '',
    '1. Use `manual` first if you want zero provider calls.',
    '2. Use `claude-cli` for local non-interactive Claude Code execution.',
    '3. Use `permissionProfile: bypass` only for trusted tasks that need unrestricted Git metadata or shell operations.'
  ].filter((line): line is string => line !== undefined).join('\n');

  return { okForCli, markdown };
}

async function runCheck(command: string, args: string[], shell: boolean): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024, timeout: 20000, shell });
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

function fenced(value: string): string {
  return ['```text', value.trim(), '```'].join('\n');
}
