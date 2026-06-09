import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { RunArtifact, RunRecord, TaskSpec } from '../domain/types';
import { isFinalStatus } from '../domain/validation';
import { JsonStore } from './jsonStore';

interface PersistedState {
  tasks: TaskSpec[];
  runs: RunRecord[];
}

export class TaskStore {
  private readonly stateStore: JsonStore<PersistedState>;
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly rootPath: string) {
    this.stateStore = new JsonStore<PersistedState>(path.join(rootPath, 'state', 'kanbasutra.json'), {
      tasks: [],
      runs: []
    });
  }

  async getTasks(): Promise<TaskSpec[]> {
    return (await this.stateStore.read()).tasks;
  }

  async getRuns(): Promise<RunRecord[]> {
    return (await this.stateStore.read()).runs;
  }

  async upsertTask(task: TaskSpec): Promise<void> {
    const state = await this.stateStore.read();
    const index = state.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      state.tasks[index] = task;
    } else {
      state.tasks.push(task);
    }
    await this.stateStore.write(state);
    this.onDidChange.fire();
  }

  async upsertTasks(tasks: TaskSpec[]): Promise<void> {
    const state = await this.stateStore.read();
    for (const task of tasks) {
      const index = state.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) {
        state.tasks[index] = task;
      } else {
        state.tasks.push(task);
      }
    }
    await this.stateStore.write(state);
    this.onDidChange.fire();
  }

  async deleteTask(taskId: string): Promise<void> {
    const state = await this.stateStore.read();
    const runIds = state.runs.filter((run) => run.taskId === taskId).map((run) => run.id);
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    state.runs = state.runs.filter((run) => run.taskId !== taskId);
    await this.stateStore.write(state);
    await this.deleteArtifactDirs(runIds);
    this.onDidChange.fire();
  }

  async upsertRun(run: RunRecord): Promise<void> {
    const state = await this.stateStore.read();
    const index = state.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) {
      state.runs[index] = run;
    } else {
      state.runs.push(run);
    }
    await this.stateStore.write(state);
    this.onDidChange.fire();
  }

  async cleanupCompleted(afterDays: number, keepFailed: boolean): Promise<number> {
    const state = await this.stateStore.read();
    const cutoff = Date.now() - afterDays * 24 * 60 * 60 * 1000;
    const removableIds = new Set(
      state.tasks
        .filter((task) => isFinalStatus(task.status))
        .filter((task) => !(keepFailed && task.status === 'failed'))
        .filter((task) => task.completedAt && new Date(task.completedAt).getTime() < cutoff)
        .map((task) => task.id)
    );

    if (removableIds.size === 0) {
      return 0;
    }

    const runIds = state.runs.filter((run) => removableIds.has(run.taskId)).map((run) => run.id);
    state.tasks = state.tasks.filter((task) => !removableIds.has(task.id));
    state.runs = state.runs.filter((run) => !removableIds.has(run.taskId));
    await this.stateStore.write(state);
    await this.deleteArtifactDirs(runIds);
    this.onDidChange.fire();
    return removableIds.size;
  }

  async writeArtifact(runId: string, kind: RunArtifact['kind'], label: string, fileName: string, content: string): Promise<RunArtifact> {
    const artifactDir = path.join(this.rootPath, 'artifacts', runId);
    await fs.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, fileName);
    await fs.writeFile(artifactPath, content, 'utf8');
    return {
      id: randomUUID(),
      kind,
      label,
      path: artifactPath,
      byteLength: Buffer.byteLength(content)
    };
  }

  private async deleteArtifactDirs(runIds: string[]): Promise<void> {
    await Promise.all(
      runIds.map((runId) =>
        fs.rm(path.join(this.rootPath, 'artifacts', runId), {
          recursive: true,
          force: true
        })
      )
    );
  }
}
