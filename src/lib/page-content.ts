import { z } from 'astro/zod';

const text = z.string().trim().min(1);
const heading = z.object({ title: text, eyebrow: text });
const common = { title: text, description: text };

export const pageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('home'),
    ...common,
    caption: text,
    primaryAction: z.object({ label: text, href: text.regex(/^\/(?!\/)/, '请使用站内路径') }),
    process: z.object({
      label: text,
      description: text,
      steps: z.array(z.object({ title: text, description: text, transition: text.optional() })).min(1),
    }),
    featuredCourseIds: z.array(text.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1)
      .refine((ids) => new Set(ids).size === ids.length, '精选课程不能重复'),
    sections: z.object({ courses: heading, trajectories: heading, notes: heading }),
    archive: z.object({ notice: text, localNotice: text, allLabel: text }),
    notes: z.object({ allLabel: text, repositoryLabel: text, historicalLabel: text }),
  }),
  z.object({ kind: z.literal('page'), ...common, eyebrow: text.optional() }),
]);

export function selectFeaturedProjects<T extends { id: string }>(ids: readonly string[], projects: readonly T[]): T[] {
  return ids.map((id) => {
    const project = projects.find((item) => item.id === id);
    if (!project) throw new Error(`src/content/pages/home.md: featuredCourseIds 中的课程「${id}」不存在于公开课程数据。`);
    return project;
  });
}
