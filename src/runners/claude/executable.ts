import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ResolvedClaudeExecutable {
  command: string;
  argsPrefix: string[];
  shell: boolean;
  resolvedPath: string;
  configuredExecutable: string;
}

export async function resolveClaudeExecutable(configuredExecutable: string): Promise<ResolvedClaudeExecutable> {
  const executable = configuredExecutable.trim() || 'claude';
  const resolvedPath = hasPathSegment(executable) ? executable : await resolveFromPath(executable);
  return {
    command: resolvedPath,
    argsPrefix: [],
    shell: shouldUseShell(resolvedPath),
    resolvedPath,
    configuredExecutable: executable
  };
}

async function resolveFromPath(executable: string): Promise<string> {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, [executable], { timeout: 5000 });
    const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!paths.length) {
      return executable;
    }
    if (process.platform !== 'win32') {
      return paths[0];
    }
    return paths.find((item) => item.toLowerCase().endsWith('.cmd'))
      ?? paths.find((item) => item.toLowerCase().endsWith('.exe'))
      ?? paths[0];
  } catch {
    return executable;
  }
}

function hasPathSegment(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.basename(value) !== value;
}

function shouldUseShell(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath);
}
