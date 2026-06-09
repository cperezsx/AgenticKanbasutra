import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { resolveCopilotExecutable, resolveGitHubExecutable, ResolvedExecutable } from './executable';
import { resolveGitHubRepository } from './repository';

const execFileAsync = promisify(execFile);

export interface CopilotReadinessReport {
  okForCli: boolean;
  okForCloud: boolean;
  markdown: string;
}

export async function checkCopilotEnvironment(repositoryPath?: string): Promise<CopilotReadinessReport> {
  const config = vscode.workspace.getConfiguration('agenticKanbasutra');
  const copilotExecutable = await resolveCopilotExecutable(config.get<string>('runners.copilotCli.executable', 'copilot'));
  const ghExecutable = await resolveGitHubExecutable(config.get<string>('runners.github.executable', 'gh'));
  const copilot = await runCheck(copilotExecutable, ['version']);
  const copilotHelp = await runCheck(copilotExecutable, ['help']);
  const ghVersion = await runCheck(ghExecutable, ['--version']);
  const gh = await runCheck(ghExecutable, ['auth', 'status']);
  const codeExtensions = await runCheck('code', ['--list-extensions', '--show-versions']);
  const repo = await resolveGitHubRepository(repositoryPath);
  const hasCopilotExtension = extensionListHas(codeExtensions.output, 'github.copilot');
  const hasCopilotChatExtension = extensionListHas(codeExtensions.output, 'github.copilot-chat');

  const okForCli = copilot.ok;
  const okForCloud = ghVersion.ok && gh.ok && Boolean(repo);

  const markdown = [
    '# AgenticKanbasutra Copilot Readiness',
    '',
    `Repository path: ${repositoryPath ?? 'not resolved'}`,
    '',
    '## Summary',
    '',
    `- Copilot CLI runner: ${okForCli ? 'ready' : 'not ready'}`,
    `- GitHub CLI: ${ghVersion.ok ? 'installed' : 'not found'} / ${gh.ok ? 'authenticated' : 'not authenticated'}`,
    `- Copilot Cloud runner: ${okForCloud ? 'ready' : 'not ready'}`,
    '',
    '## Copilot CLI',
    '',
    `Resolved executable: \`${copilotExecutable.resolvedPath}\`.`,
    copilotExecutable.configuredExecutable !== copilotExecutable.resolvedPath ? `Configured executable: \`${copilotExecutable.configuredExecutable}\`.` : undefined,
    '',
    copilot.ok ? 'Status: available.' : 'Status: not available.',
    '',
    fenced(copilot.output || copilot.error || 'No output.'),
    '',
    copilotHelp.ok ? 'Programmatic flags: available.' : 'Programmatic flags: could not read `copilot help`.',
    '',
    fenced(copilotFlagSummary(copilotHelp.output || copilotHelp.error || 'No output.')),
    '',
    'Notes:',
    '',
    '- This check is for GitHub Copilot CLI, not a generic Copilot-compatible provider.',
    '- Copilot CLI authentication is fully verified when the first task runs because the CLI currently does not expose a stable non-interactive status command.',
    '- If the CLI asks you to log in, run `copilot login` in a terminal.',
    '- If an update is available, run `copilot update` when convenient.',
    '',
    '## GitHub CLI',
    '',
    `Resolved executable: \`${ghExecutable.resolvedPath}\`.`,
    ghExecutable.configuredExecutable !== ghExecutable.resolvedPath ? `Configured executable: \`${ghExecutable.configuredExecutable}\`.` : undefined,
    '',
    ghVersion.ok ? 'Status: installed.' : 'Status: not found.',
    '',
    fenced(ghVersion.output || ghVersion.error || 'No output.'),
    '',
    gh.ok ? 'Authentication: authenticated.' : 'Authentication: not authenticated or unavailable.',
    '',
    fenced(gh.output || gh.error || 'No output.'),
    '',
    'Cloud execution requires `gh auth login` or a compatible GitHub token.',
    '',
    '## VS Code GitHub Copilot Chat',
    '',
    codeExtensions.ok ? 'VS Code CLI: available.' : 'VS Code CLI: not available from this shell.',
    '',
    `- GitHub.copilot: ${hasCopilotExtension ? 'listed' : 'not listed in this CLI profile'}`,
    `- GitHub.copilot-chat: ${hasCopilotChatExtension ? 'listed' : 'not listed in this CLI profile'}`,
    '',
    'If Copilot Chat is visible in VS Code but not listed here, the running VS Code profile or installation may differ from the `code` executable on PATH.',
    '',
    '## Reference Commands',
    '',
    `- Check Copilot CLI: \`${copilotExecutable.resolvedPath} version\`.`,
    `- Inspect Copilot CLI flags: \`${copilotExecutable.resolvedPath} help\`.`,
    `- Start Copilot CLI login when prompted: \`${copilotExecutable.resolvedPath} login\`.`,
    `- Check GitHub CLI installation: \`${ghExecutable.resolvedPath} --version\`.`,
    `- Check GitHub CLI authentication: \`${ghExecutable.resolvedPath} auth status\`.`,
    `- Start GitHub CLI login for Cloud execution: \`${ghExecutable.resolvedPath} auth login\`.`,
    '- Check VS Code extensions: `code --list-extensions --show-versions`.',
    '',
    '## GitHub Repository',
    '',
    repo ? `Resolved: ${repo.owner}/${repo.name}` : 'Could not resolve a GitHub `owner/repo` from `origin`.',
    '',
    repo ? `Remote: ${repo.remoteUrl}` : 'Set a GitHub `origin` remote before using Copilot Cloud.',
    '',
    '## Recommended Flow',
    '',
    '1. Use `copilot-cli` for local/background execution.',
    '2. Use `copilot-cloud` only for GitHub-hosted repositories where Cloud Agent is enabled.',
    '3. Use `manual` when you want to paste the generated task into VS Code local Agent or Agents Window yourself.'
  ].filter((line): line is string => line !== undefined).join('\n');

  return { okForCli, okForCloud, markdown };
}

async function runCheck(executable: ResolvedExecutable | string, args: string[]): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const command = typeof executable === 'string' ? executable : executable.command;
    const prefix = typeof executable === 'string' ? [] : executable.argsPrefix;
    const shell = typeof executable === 'string' ? false : executable.shell;
    const { stdout, stderr } = await execFileAsync(command, [...prefix, ...args], { maxBuffer: 1024 * 1024, timeout: 15000, shell });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
  } catch (error) {
    const anyError = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    return {
      ok: false,
      error: [
        anyError.stdout,
        anyError.stderr,
        anyError.killed ? 'Command timed out after 15 seconds.' : undefined,
        anyError.message
      ].filter(Boolean).join('\n').trim()
    };
  }
}

function fenced(value: string): string {
  return ['```text', value.trim(), '```'].join('\n');
}

function extensionListHas(output: string | undefined, extensionId: string): boolean {
  return String(output || '')
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase().startsWith(extensionId.toLowerCase()));
}

function copilotFlagSummary(helpOutput: string): string {
  const flags = [
    '--prompt',
    '--share',
    '--add-dir',
    '--agent',
    '--model',
    '--allow-tool',
    '--deny-tool',
    '--available-tools',
    '--excluded-tools',
    '--allow-all',
    '--yolo',
    '--no-ask-user',
    '--additional-mcp-config'
  ];
  const lines = flags.map((flag) => `${flag}: ${helpOutput.includes(flag) ? 'available' : 'not found'}`);
  return lines.join('\n');
}
