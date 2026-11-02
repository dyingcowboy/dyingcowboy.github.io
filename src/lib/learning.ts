import data from '../data/learning.json';
import publicArchive from '../data/trajectories.json';
import type { Trajectory } from './types';

export interface LearningRepository {
  id: string;
  state: 'ready' | 'missing' | 'error';
  branch: string | null;
  commit: string | null;
  remoteUrl: string | null;
  dirty: boolean | null;
}
export interface LearningProject {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused';
  state: 'ready' | 'partial' | 'missing' | 'unconfigured' | 'error';
  repositories: LearningRepository[];
  noteIds: string[];
  trajectoryIds: string[];
  trajectoryCount: number;
  sessionCount: number;
  models: string[];
  warnings: string[];
}
export interface LearningNote {
  id: string;
  projectId: string;
  repoId: string;
  path: string;
  title: string;
  body?: string;
  html?: string;
  sha256: string;
  commit: string | null;
  sourceUrl: string | null;
  observedAt: string;
  modified: boolean;
}
export interface LearningView {
  version: number;
  projectionVersion: number;
  generatedAt: string | null;
  projects: LearningProject[];
  notes: LearningNote[];
}
const publicRecords = publicArchive.trajectories as Trajectory[];
export const publicLearning: LearningView = {
  ...data as LearningView,
  projects: (data.projects as LearningProject[]).map((project) => {
    const records = publicRecords.filter((record) => !record.demo && record.topic === project.title);
    const sessions = records.flatMap((record) => record.sessions);
    return { ...project, trajectoryIds: records.map((record) => record.id), trajectoryCount: records.length,
      sessionCount: sessions.length, models: [...new Set(sessions.flatMap((session) => session.models))] };
  }),
};
