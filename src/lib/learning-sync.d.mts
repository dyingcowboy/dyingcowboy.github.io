import type { Trajectory } from './types';

export interface LearningConfig {
  version: 1;
  sessionsSince?: string;
  projects: {
    id: string;
    title: string;
    description: string;
    status: 'active' | 'paused';
    repositories: { id: string; path: string }[];
    notes: { repoId: string; path: string }[];
    publishNotes: boolean;
  }[];
}
export interface LearningNote {
  id: string;
  projectId: string;
  repoId: string;
  path: string;
  title: string;
  body: string;
  html: string;
  sha256: string;
  commit: string | null;
  sourceUrl: string | null;
  observedAt: string;
  modified: boolean;
}
export interface LearningProject {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused';
  state: 'ready' | 'partial' | 'missing' | 'unconfigured' | 'error';
  repositories: {
    id: string;
    state: 'ready' | 'missing' | 'error';
    branch: string | null;
    commit: string | null;
    remoteUrl: string | null;
    dirty: boolean | null;
  }[];
  noteIds: string[];
  trajectoryIds: string[];
  trajectoryCount: number;
  sessionCount: number;
  models: string[];
  warnings: string[];
}
export interface LearningView {
  version: 1;
  projectionVersion: 1;
  generatedAt: string;
  projects: LearningProject[];
  notes: LearningNote[];
}
export interface SyncLearningOptions {
  config: LearningConfig;
  learningRoot: string;
  codexRoots?: string[];
  deepseekRoots?: string[];
  outputDir: string;
  publicFile: string;
  renderNote: (body: string, context: { path: string; sourceUrl: string | null; remoteUrl: string | null; commit: string | null }) => Promise<{ title: string; html: string }>;
  now?: string | Date | (() => string | Date);
}
export function syncLearning(options: SyncLearningOptions): Promise<{
  changed: boolean;
  view: LearningView;
  publicView: LearningView;
  archive: { version: 1; trajectories: Trajectory[] };
  errors: string[];
  stats: { projects: number; repositories: number; sources: number; parsedFiles: number; cachedFiles: number; notes: number; trajectories: number; sessions: number; rawSnapshots: number };
}>;
