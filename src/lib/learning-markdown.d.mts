export function renderLearningNote(body: string, context: {path: string; sourceUrl?: string | null; remoteUrl?: string | null; commit?: string | null}): Promise<{title: string; html: string}>;
export namespace renderLearningNote { const cacheVersion: number; }
