import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { ChangedFile, TaskSpec } from '../domain/types';

const execFileAsync = promisify(execFile);

export class GitService {
  async isGitRepository(repositoryPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree'], {
        maxBuffer: 1024 * 1024
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getBranches(repositoryPath: string): Promise<Array<{ label: string; name: string; current: boolean }>> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'branch', '--format=%(if)%(HEAD)%(then)*%(else) %(end)%(refname:short)'], {
        maxBuffer: 1024 * 1024
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
          const current = line.startsWith('*');
          const name = line.slice(1).trim();
          return {
            label: current ? `${name} (current)` : name,
            name,
            current
          };
        });
    } catch {
      return [];
    }
  }

  async getCurrentBranch(repositoryPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'branch', '--show-current'], {
        maxBuffer: 1024 * 1024
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async getRoot(repositoryPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
        maxBuffer: 1024 * 1024
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async prepareWorktree(
    repositoryPath: string,
    storageRootPath: string,
    task: TaskSpec
  ): Promise<{ path: string; branch: string; baseRef: string }> {
    const worktreeRoot = path.join(storageRootPath, 'worktrees');
    const worktreePath = path.join(worktreeRoot, task.id);
    await fs.mkdir(worktreeRoot, { recursive: true });

    const baseRef = task.branchBase || await this.getCurrentBranch(repositoryPath) || 'HEAD';
    if (await exists(worktreePath)) {
      return {
        path: worktreePath,
        branch: await this.getCurrentBranch(worktreePath) || path.basename(worktreePath),
        baseRef
      };
    }

    const branchName = `agentickanbasutra-${task.id.slice(0, 8)}-${Date.now()}`;
    await execFileAsync('git', ['-C', repositoryPath, 'worktree', 'add', '-b', branchName, worktreePath, baseRef], {
      maxBuffer: 1024 * 1024
    });
    return {
      path: worktreePath,
      branch: branchName,
      baseRef
    };
  }

  async getChangedFiles(repositoryPath: string): Promise<ChangedFile[]> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'status', '--short'], {
        maxBuffer: 1024 * 1024
      });
      const stats = await this.getDiffStats(repositoryPath);
      return stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const file = parseStatusLine(line);
          const stat = stats.get(file.path);
          return stat ? { ...file, ...stat } : file;
        });
    } catch {
      return [];
    }
  }

  async getDiff(repositoryPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'diff', '--binary'], {
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout;
    } catch {
      return '';
    }
  }

  private async getDiffStats(repositoryPath: string): Promise<Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>> {
    const stats = new Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>();
    for (const args of [
      ['-C', repositoryPath, 'diff', '--numstat'],
      ['-C', repositoryPath, 'diff', '--cached', '--numstat']
    ]) {
      try {
        const { stdout } = await execFileAsync('git', args, {
          maxBuffer: 1024 * 1024
        });
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
          const parsed = parseNumstatLine(line);
          if (!parsed) {
            continue;
          }
          const existing = stats.get(parsed.path) ?? { additions: 0, deletions: 0 };
          stats.set(parsed.path, {
            additions: (existing.additions ?? 0) + parsed.additions,
            deletions: (existing.deletions ?? 0) + parsed.deletions
          });
        }
      } catch {
        // Some repositories or Git versions may not expose every stat path; keep status data.
      }
    }
    return stats;
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseStatusLine(line: string): ChangedFile {
  const code = line.slice(0, 2);
  const filePath = normalizeChangedPath(line.slice(3).trim());
  if (code.includes('A')) {
    return { path: filePath, status: 'added' };
  }
  if (code.includes('D')) {
    return { path: filePath, status: 'deleted' };
  }
  if (code.includes('R')) {
    return { path: filePath, status: 'renamed' };
  }
  if (code.includes('M')) {
    return { path: filePath, status: 'modified' };
  }
  return { path: filePath, status: 'unknown' };
}

function parseNumstatLine(line: string): { path: string; additions: number; deletions: number } | undefined {
  const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
  const filePath = normalizeChangedPath(pathParts.join('\t').trim());
  if (!filePath) {
    return undefined;
  }
  return {
    path: filePath,
    additions: parseGitStat(rawAdditions),
    deletions: parseGitStat(rawDeletions)
  };
}

function parseGitStat(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeChangedPath(filePath: string): string {
  const renameMatch = filePath.match(/^(.*)\s+->\s+(.*)$/);
  if (renameMatch) {
    return renameMatch[2].trim();
  }
  const braceRenameMatch = filePath.match(/^(.*){.*\s=>\s(.*)}(.*)$/);
  if (braceRenameMatch) {
    return `${braceRenameMatch[1]}${braceRenameMatch[2]}${braceRenameMatch[3]}`.trim();
  }
  return filePath;
}
