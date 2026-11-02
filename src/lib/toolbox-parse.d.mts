export type Maturity = 'empty' | 'stub' | 'growing' | 'mature';

export interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

export interface MarkdownSection {
  heading: string | null;
  level: number;
  lines: string[];
}

export interface ModuleEntry {
  name: string;
  raw: string;
}

export interface ParsedNote {
  path: string;
  title: string;
  chars: number;
  tags: string[];
  links: string[];
  excerpt: string;
  maturity: Maturity;
  updated: string;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter;
export function splitSections(markdown: string): MarkdownSection[];
export function extractModules(markdown: string): ModuleEntry[];
export function moduleSlug(name: string, index: number): string;
export function extractLinks(markdown: string): string[];
export function countChars(text: string): number;
export function extractExcerpt(body: string, limit?: number): string;
export function maturityOf(chars: number): Maturity;
export function parseNote(markdown: string, options: { path: string; fallbackTitle?: string }): ParsedNote;
export function groupNotes<T extends { name: string }>(
  modules: T[],
  notes: ParsedNote[],
): { groups: (T & { notes: ParsedNote[] })[]; unfiled: ParsedNote[] };
