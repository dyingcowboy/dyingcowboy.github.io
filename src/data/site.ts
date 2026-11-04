import type { IconName } from '../lib/icons';
import type { Category } from '../lib/types';

export interface NavigationItem {
  href: string;
  label: string;
  en: string;
  icon: IconName;
  category?: Category;
}

const navigation: readonly NavigationItem[] = [
  { href: '/', label: '概览', en: 'Overview', icon: 'grid' },
  { href: '/learning/', label: '当前课程', en: 'Courses', icon: 'book' },
  { href: '/trajectories/', label: '全部轨迹', en: 'Trajectories', icon: 'route' },
  { href: '/trajectories/?category=project', label: '项目', en: 'Projects', icon: 'folder', category: 'project' },
  { href: '/trajectories/?category=study', label: '学习', en: 'Study', icon: 'book', category: 'study' },
  { href: '/trajectories/?category=knowledge', label: '思考', en: 'Thinking', icon: 'spark', category: 'knowledge' },
  { href: '/notes/', label: '笔记', en: 'Notes', icon: 'note' },
];

const name = 'Xuanshi Xi';
const chineseName = '席轩石';

export const site = {
  name,
  chineseName,
  role: 'M.Sc. Student',
  description: `${chineseName}的学习与实践档案。记录项目、学习和思考，以及每一步如何形成。`,
  subtitle: '学习与实践',
  mark: 'x',
  links: {
    github: 'https://github.com/dyingcowboy',
  },
  navigation,
  workspace: {
    label: 'PERSONAL LEARNING ARCHIVE',
    importLabel: '本地导入',
    importHref: '/trajectories/?import=1',
  },
  sidebar: {
    label: 'WORKSPACE',
    note: ['Keep the questions.', 'Show the process.'],
    caption: '一份持续生长的个人档案',
    aboutLabel: '关于我',
    aboutHref: '/about/',
  },
  footer: {
    since: 2026,
    caption: 'Built through questions, one step at a time.',
  },
} as const;

export function siteTitle(title?: string): string {
  return title ? `${title} — ${site.name}` : site.name;
}
