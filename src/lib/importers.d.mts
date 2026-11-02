import type { Session, Trajectory } from './types';
export const PARSER_VERSION: number;

/** Reads source locations and parser-version 2 metadata without changing the raw log. */
export function parseCodex(text: string): Session;
/** Projects tested DeepSeek v4 append-origin messages, retaining source event positions. */
export function parseDeepSeek(text: string): Session;
/** Reads raw records or a version-1 archive, preserving optional source metadata. */
export function parseImport(input: string | Uint8Array, filename?: string): Trajectory[];
