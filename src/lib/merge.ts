import type { Message, Session, SessionProvenance, Trajectory } from './types';

type Order = -1 | 0 | 1;

function earlier(a: string | null, b: string | null): string | null {
  return a && b ? (a < b ? a : b) : (a ?? b);
}

function later(a: string | null, b: string | null): string | null {
  return a && b ? (a > b ? a : b) : (a ?? b);
}

function incomingOrder(a: number | string, b: number | string): Order {
  return a === b ? 0 : b > a ? 1 : -1;
}

function sameFormat(a: Session, b: Session): boolean {
  return a.provenance !== undefined && b.provenance !== undefined
    && a.provenance.format === b.provenance.format
    && a.provenance.formatVersion === b.provenance.formatVersion;
}

function sourceCutOrder(previous: Session, incoming: Session): Order | null {
  if (!sameFormat(previous, incoming)) return null;
  const a = previous.provenance!;
  const b = incoming.provenance!;
  if (a.lastSequence !== undefined && b.lastSequence !== undefined) {
    return incomingOrder(a.lastSequence, b.lastSequence);
  }
  if (a.eventCount !== undefined && b.eventCount !== undefined) {
    return incomingOrder(a.eventCount, b.eventCount);
  }
  return null;
}

function snapshotOrder(previous: Session, incoming: Session): Order | null {
  const cut = sourceCutOrder(previous, incoming);
  if (cut !== null) {
    if (cut === 0 && previous.provenance && incoming.provenance) {
      return incomingOrder(previous.provenance.parserVersion, incoming.provenance.parserVersion);
    }
    return cut;
  }
  return previous.updatedAt && incoming.updatedAt
    ? incomingOrder(previous.updatedAt, incoming.updatedAt)
    : null;
}

function messageOrder(a: Message, b: Message, previous: Session, incoming: Session): Order | null {
  if (sameFormat(previous, incoming)) {
    if (a.origin?.sequence !== undefined && b.origin?.sequence !== undefined
      && a.origin.sequence !== b.origin.sequence) {
      return incomingOrder(a.origin.sequence, b.origin.sequence);
    }
    if (previous.provenance?.format === 'codex-rollout'
      && a.origin?.line !== undefined && b.origin?.line !== undefined
      && a.origin.line !== b.origin.line) {
      return incomingOrder(a.origin.line, b.origin.line);
    }
    const cut = snapshotOrder(previous, incoming);
    if (cut !== null) return cut;
  }
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
    return incomingOrder(a.timestamp, b.timestamp);
  }
  return snapshotOrder(previous, incoming);
}

function sourceMetadata(
  preferred: SessionProvenance | undefined,
  other: SessionProvenance | undefined,
  existingRepoId: string | undefined,
): SessionProvenance | undefined {
  if (!preferred && !other) return undefined;
  // Only the chosen snapshot can supply its watermark, digest, or observation time.
  const { eventCount: _count, lastSequence: _seq, sha256: _hash, observedAt: _time, ...staticFields } = other ?? {};
  const result = { ...staticFields, ...preferred } as SessionProvenance;
  if (existingRepoId !== undefined) result.repoId = existingRepoId;
  if (result.git) result.git = { ...result.git };
  return result;
}

function sourceOrderedMessages(
  base: Message[],
  supplement: Message[],
  selected: Map<string, Message>,
  previous: Session,
  incoming: Session,
): Message[] {
  const baseIds = new Set(base.map((message) => message.id));
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const message of supplement) {
    if (!baseIds.has(message.id)) pending.push(message.id);
    else if (pending.length) {
      before.set(message.id, pending);
      pending = [];
    }
  }
  const ids = base.flatMap((message) => [...(before.get(message.id) ?? []), message.id]);
  ids.push(...pending);
  const messages = ids.map((messageId) => selected.get(messageId)!);
  if (sameFormat(previous, incoming)) {
    const position = (message: Message): number | undefined => previous.provenance?.format === 'deepseek-session'
      ? message.origin?.sequence
      : message.origin?.line;
    if (messages.every((message) => position(message) !== undefined)) {
      messages.sort((a, b) => position(a)! - position(b)!);
    }
  }
  return messages;
}

function mergeSession(previous: Session, incoming: Session): Session {
  const order = snapshotOrder(previous, incoming);
  const preferred = order === 1 ? incoming : previous;
  const other = order === 1 ? previous : incoming;
  const selected = new Map(previous.messages.map((message) => [message.id, message]));
  const warnings = new Set([...previous.warnings, ...incoming.warnings]);
  for (const message of incoming.messages) {
    const current = selected.get(message.id);
    if (!current) {
      selected.set(message.id, message);
      continue;
    }
    const newer = messageOrder(current, message, previous, incoming);
    if (newer === 1) selected.set(message.id, message);
    else if (current.content !== message.content || current.role !== message.role) {
      warnings.add(newer === -1
        ? '已保留较新消息，未用旧快照回滚同 ID 正文。'
        : '无法确定同 ID 消息哪个版本更新，已保留当前正文；请对照原始记录。');
    } else {
      selected.set(message.id, {
        ...current,
        model: current.model ?? message.model,
        ...(current.origin || !message.origin ? {} : { origin: message.origin }),
      });
    }
  }
  const provenance = sourceMetadata(preferred.provenance, other.provenance, previous.provenance?.repoId);
  return {
    ...preferred,
    startedAt: earlier(previous.startedAt, incoming.startedAt),
    updatedAt: later(previous.updatedAt, incoming.updatedAt),
    messages: sourceOrderedMessages(previous.messages, incoming.messages, selected, previous, incoming),
    models: [...new Set([...previous.models, ...incoming.models])],
    warnings: [...warnings],
    ...(provenance ? { provenance } : {}),
  };
}

/** Merge source records while keeping the existing human title, review, and classifications. */
export function mergeTrajectory(previous: Trajectory, incoming: Trajectory): Trajectory {
  const sessionKey = (session: Session): string => `${session.source}:${session.id}`;
  const sessions = new Map(previous.sessions.map((session) => [sessionKey(session), session]));
  const checkpoints = new Map(previous.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  for (const checkpoint of incoming.checkpoints) {
    if (!checkpoints.has(checkpoint.id)) checkpoints.set(checkpoint.id, checkpoint);
  }
  const links = new Map(previous.links.map((link) => [link.href, link]));
  for (const link of incoming.links) if (!links.has(link.href)) links.set(link.href, link);
  for (const session of incoming.sessions) {
    const key = sessionKey(session);
    const existing = sessions.get(key);
    sessions.set(key, existing ? mergeSession(existing, session) : session);
  }
  return {
    ...previous,
    startedAt: earlier(previous.startedAt, incoming.startedAt),
    updatedAt: later(previous.updatedAt, incoming.updatedAt),
    sessions: [...sessions.values()],
    checkpoints: [...checkpoints.values()],
    links: [...links.values()],
    tags: [...new Set([...previous.tags, ...incoming.tags])],
  };
}
