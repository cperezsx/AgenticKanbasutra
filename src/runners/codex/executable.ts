import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export async function resolveCodexExecutable(configuredExecutable: string): Promise<string> {
  const executable = configuredExecutable.trim() || 'codex';
  if (hasPathSegment(executable)) {
    return executable;
  }

  const fromPath = await resolveFromPath(executable);
  if (fromPath) {
    return fromPath;
  }

  const fromOpenAiExtension = await resolveFromOpenAiExtension();
  return fromOpenAiExtension ?? executable;
}

function hasPathSegment(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.basename(value) !== value;
}

async function resolveFromPath(executable: string): Promise<string | undefined> {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, [executable], { timeout: 5000 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

async function resolveFromOpenAiExtension(): Promise<string | undefined> {
  const extensionPath = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
  if (!extensionPath) {
    return undefined;
  }

  const candidates = process.platform === 'win32'
    ? await listFiles(path.join(extensionPath, 'bin'), 'codex.exe')
    : await listFiles(path.join(extensionPath, 'bin'), 'codex');

  return candidates[0];
}

async function listFiles(rootPath: string, fileName: string): Promise<string[]> {
  const matches: string[] = [];

  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (depth > 4 || matches.length > 0) {
      return;
    }

    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        matches.push(entryPath);
        return;
      }
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      }
    }
  }

  await visit(rootPath, 0);
  return matches;
}
