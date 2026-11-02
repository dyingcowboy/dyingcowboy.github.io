export type Source = 'codex' | 'deepseek';
export type Category = 'project' | 'study' | 'knowledge';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string | null;
  model: string | null;
  toolName?: string;
  callId?: string;
  origin?: {
    id?: string;
    sequence?: number;
    line?: number;
  };
}

export interface SessionProvenance {
  format: 'codex-rollout' | 'deepseek-session';
  formatVersion: number | null;
  parserVersion: number;
  sourceId?: string;
  cwd?: string;
  parentSessionId?: string;
  appVersion?: string;
  eventCount?: number;
  lastSequence?: number;
  repoId?: string;
  sha256?: string;
  observedAt?: string;
  git?: {
    commit?: string;
    branch?: string;
    remoteUrl?: string;
  };
}

export interface Session {
  id: string;
  source: Source;
  startedAt: string | null;
  updatedAt: string | null;
  models: string[];
  messages: Message[];
  warnings: string[];
  provenance?: SessionProvenance;
}

export interface Checkpoint {
  id: string;
  messageId: string;
  kind: 'question' | 'decision' | 'insight' | 'verification';
  title: string;
  body: string;
}

export interface Trajectory {
  version: 1;
  id: string;
  title: string;
  description: string;
  category: Category;
  topic: string;
  status: 'ongoing' | 'completed';
  startedAt: string | null;
  updatedAt: string | null;
  tags: string[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  links: { title: string; href: string }[];
  demo?: boolean;
}
