import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitHubRepository {
  owner: string;
  name: string;
  remoteUrl: string;
}

export async function resolveGitHubRepository(repositoryPath?: string, remoteUrl?: string): Promise<GitHubRepository | undefined> {
  const url = remoteUrl || (repositoryPath ? await getOriginUrl(repositoryPath) : undefined);
  if (!url) {
    return undefined;
  }
  const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], name: sshMatch[2], remoteUrl: url };
  }
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], name: httpsMatch[2], remoteUrl: url };
  }
  return undefined;
}

async function getOriginUrl(repositoryPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'config', '--get', 'remote.origin.url']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

