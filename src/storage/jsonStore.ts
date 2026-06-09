import * as fs from 'fs/promises';
import * as path from 'path';

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: T
  ) {}

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(stripBom(raw)) as T;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return this.fallback;
      }
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
