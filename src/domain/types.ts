export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type ExecutionMode = 'manual' | 'foreground' | 'background';
export type QueueExecutionMode = 'manual' | 'automatic';
export type IsolationMode = 'none' | 'workspace' | 'worktree';
export type PermissionProfile = 'read_only' | 'ask' | 'allow_workspace' | 'allow_worktree' | 'bypass';

export interface RepositoryRef {
  type: 'workspace' | 'localPath' | 'github';
  label: string;
  path?: string;
  remoteUrl?: string;
}

export interface RunnerSelection {
  id: 'manual' | 'generic-cli' | string;
}

export interface AgentSelection {
  id: string;
  label: string;
}

export interface ModelSelection {
  id: string;
  label: string;
}

export interface ToolsProfileSelection {
  id: string;
  label: string;
}

export interface TaskContextItem {
  id: string;
  kind: 'file' | 'folder' | 'note';
  label: string;
  path?: string;
  content?: string;
  description?: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  spec: string;
  repository: RepositoryRef;
  runner: RunnerSelection;
  agent: AgentSelection;
  model: ModelSelection;
  toolsProfile: ToolsProfileSelection;
  executionMode: ExecutionMode;
  isolationMode: IsolationMode;
  permissionProfile: PermissionProfile;
  status: TaskStatus;
  priority: Priority;
  queueRank?: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastRunId?: string;
  dueAt?: string;
  branchBase?: string;
  notes?: string;
  contextItems?: TaskContextItem[];
  linkedIssue?: string;
}

export interface RunArtifact {
  id: string;
  kind: 'prompt' | 'stdout' | 'stderr' | 'summary' | 'diff' | 'metadata';
  label: string;
  path: string;
  byteLength?: number;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  additions?: number;
  deletions?: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  runnerId: string;
  status: TaskStatus;
  repository: RepositoryRef;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  summary?: string;
  artifacts: RunArtifact[];
  changedFiles: ChangedFile[];
  branchBase?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  error?: SerializedError;
}

export interface SerializedError {
  message: string;
  category: 'token_exhausted'
    | 'quota_exhausted'
    | 'auth_required'
    | 'permission_denied'
    | 'configuration'
    | 'network'
    | 'runner_failed'
    | 'unknown';
  stack?: string;
}

export interface BoardState {
  tasks: TaskSpec[];
  runs: RunRecord[];
  providerUsage: ProviderUsageSnapshot[];
  completedVisible: boolean;
  queuePaused: boolean;
  queueExecutionMode: QueueExecutionMode;
  queueMaxConcurrent: number;
  locale: string;
  messages: Record<string, string>;
  workspaceFolders: Array<{ label: string; path: string }>;
  workspaceBranches: Array<{ label: string; name: string; current: boolean }>;
  runners: Array<{ id: string; label: string }>;
  runnerOptions: RunnerConfigurationOption[];
  repositoryBranches: Record<string, Array<{ label: string; name: string; current: boolean }>>;
  repositoryDiscovery?: RepositoryDiscoveryInfo;
}

export type ProviderUsageStatus = 'healthy' | 'warning' | 'blocked' | 'unknown';
export type ProviderUsageConfidence = 'direct' | 'observed' | 'manual' | 'unavailable';

export interface ProviderUsageSnapshot {
  providerId: 'codex' | 'claude' | 'copilot';
  status: ProviderUsageStatus;
  confidence: ProviderUsageConfidence;
  label: string;
  percentRemaining?: number;
  percentUsed?: number;
  resetAt?: string;
  usageWindows?: ProviderUsageWindow[];
  checkedAt?: string;
  source: 'codex-doctor' | 'codex-status' | 'claude-auth-status' | 'claude-usage' | 'copilot-web' | 'runner-failure' | 'manual';
  rawSummary?: string;
  error?: string;
}

export interface ProviderUsageWindow {
  id: string;
  label: string;
  percentUsed?: number;
  percentRemaining?: number;
  windowMinutes?: number;
  resetAt?: string;
  resetAfterSeconds?: number;
}

export interface RepositoryDiscoveryInfo {
  repositoryPaths: string[];
  githubAgents: number;
  codexAgents: number;
  toolsProfiles: number;
}

export interface RunnerConfigurationOption {
  id: string;
  label: string;
  description: string;
  defaultModelId: string;
  agents: Array<{ id: string; label: string; description: string }>;
  models: Array<{ id: string; label: string; description: string }>;
  toolsProfiles: Array<{ id: string; label: string; description: string }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface RunnerContext {
  extensionStoragePath: string;
  artifactsPath: string;
  repositoryPath?: string;
  branchBase?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  maxLogBytes: number;
  commandTemplate?: string;
}

export interface ApprovalRequest {
  id: string;
  message: string;
}

export type RunnerEvent =
  | { type: 'started'; at: string }
  | { type: 'progress'; message: string; at: string }
  | { type: 'stdout'; chunk: string; at: string }
  | { type: 'stderr'; chunk: string; at: string }
  | { type: 'waiting_for_input'; prompt: string; at: string }
  | { type: 'waiting_for_approval'; approval: ApprovalRequest; at: string }
  | { type: 'artifact'; artifact: RunArtifact; at: string }
  | { type: 'completed'; result: { exitCode?: number; summary?: string }; at: string }
  | { type: 'failed'; error: SerializedError; at: string }
  | { type: 'cancelled'; reason?: string; at: string };

export interface RunHandle {
  runId: string;
  events: AsyncIterable<RunnerEvent>;
}

export interface RunnerCapabilities {
  canRunInBackground: boolean;
  canCancel: boolean;
  writesFiles: boolean;
}

export interface AgentRunner {
  id: string;
  displayName: string;
  capabilities: RunnerCapabilities;
  validate(task: TaskSpec, context: RunnerContext): Promise<ValidationResult>;
  start(task: TaskSpec, context: RunnerContext): Promise<RunHandle>;
  cancel(runId: string): Promise<void>;
}
