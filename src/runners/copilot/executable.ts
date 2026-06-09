import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ResolvedExecutable {
  command: string;
  argsPrefix: string[];
  shell: boolean;
  resolvedPath: string;
  configuredExecutable: string;
}

export async function resolveCopilotExecutable(configuredExecutable: string): Promise<ResolvedExecutable> {
  const executable = configuredExecutable.trim() || 'copilot';
  const resolvedPath = hasPathSegment(executable) ? executable : await resolveFromPath(executable, preferCopilotPath);
  const loader = process.platform === 'win32' ? await npmLoaderFromShim(resolvedPath) : undefined;
  if (loader) {
    return {
      command: await resolveNodeExecutable(),
      argsPrefix: [loader],
      shell: false,
      resolvedPath,
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

export async function resolveGitHubExecutable(configuredExecutable: string): Promise<ResolvedExecutable> {
  const executable = configuredExecutable.trim() || 'gh';
  const resolvedPath = hasPathSegment(executable) ? executable : await resolveFromPath(executable, preferExecutablePath);
  return {
    command: resolvedPath,
    argsPrefix: [],
    shell: shouldUseShell(resolvedPath),
    resolvedPath,
    configuredExecutable: executable
  };
}

export async function resolveFromPath(executable: string, prefer: (paths: string[]) => string): Promise<string> {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, [executable], { timeout: 5000 });
    const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return paths.length ? prefer(paths) : executable;
  } catch {
    return executable;
  }
}

function preferCopilotPath(paths: string[]): string {
  if (process.platform !== 'win32') {
    return paths[0];
  }
  return paths.find((item) => item.toLowerCase().endsWith('.cmd'))
    ?? paths.find((item) => item.toLowerCase().endsWith('.exe'))
    ?? paths[0];
}

function preferExecutablePath(paths: string[]): string {
  if (process.platform !== 'win32') {
    return paths[0];
  }
  return paths.find((item) => item.toLowerCase().endsWith('.exe'))
    ?? paths.find((item) => item.toLowerCase().endsWith('.cmd'))
    ?? paths[0];
}

async function npmLoaderFromShim(shimPath: string): Promise<string | undefined> {
  if (!shimPath.toLowerCase().endsWith('.cmd')) {
    return undefined;
  }
  const loaderPath = path.join(path.dirname(shimPath), 'node_modules', '@github', 'copilot', 'npm-loader.js');
  try {
    await fs.access(loaderPath);
    return loaderPath;
  } catch {
    return undefined;
  }
}

async function resolveNodeExecutable(): Promise<string> {
  return resolveFromPath('node', preferExecutablePath);
}

function hasPathSegment(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.basename(value) !== value;
}

function shouldUseShell(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath);
}
