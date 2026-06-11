import { execFile } from 'child_process';
import * as fs from 'fs/promises';
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
  const nativeBinary = process.platform === 'win32' ? await nativeClaudeBinaryFromShim(resolvedPath) : undefined;
  if (nativeBinary) {
    return {
      command: nativeBinary,
      argsPrefix: [],
      shell: false,
      resolvedPath: nativeBinary,
      configuredExecutable: executable
    };
  }

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
    return paths.find((item) => item.toLowerCase().endsWith('.exe'))
      ?? paths.find((item) => item.toLowerCase().endsWith('.cmd'))
      ?? paths.find((item) => item.toLowerCase().endsWith('.ps1'))
      ?? paths.find((item) => !path.extname(item))
      ?? paths[0];
  } catch {
    return executable;
  }
}

async function nativeClaudeBinaryFromShim(shimPath: string): Promise<string | undefined> {
  const lower = shimPath.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.ps1') && path.basename(shimPath).toLowerCase() !== 'claude') {
    return undefined;
  }
  const nativePath = path.join(path.dirname(shimPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  try {
    await fs.access(nativePath);
    return nativePath;
  } catch {
    return undefined;
  }
}

function hasPathSegment(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.basename(value) !== value;
}

function shouldUseShell(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath);
}
