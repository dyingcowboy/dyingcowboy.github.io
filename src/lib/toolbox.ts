import raw from '../data/toolbox.json';

export type Maturity = 'empty' | 'stub' | 'growing' | 'mature';

export interface ToolboxNote {
  title: string;
  path: string;
  chars: number;
  links: string[];
  excerpt: string;
  updated: string;
}

export interface ToolboxModule {
  index: number;
  slug: string;
  name: string;
  noteCount: number;
  chars: number;
  maturity: Maturity;
  notes: ToolboxNote[];
}

export interface ToolboxTotals {
  modules: number;
  modulesWithContent: number;
  notes: number;
  chars: number;
  inbox: number;
  inboxChars: number;
}

export interface ToolboxData {
  version: number;
  generatedAt: string;
  vault: string;
  title: string;
  modules: ToolboxModule[];
  totals: ToolboxTotals;
}

export const toolbox = raw as unknown as ToolboxData;

/**
 * 站点侧展示文案（英文名、短名、一句话定义）。
 *
 * 与 vault 解耦：vault 里改了模块名，这里匹配不上就回退到原名，
 * 页面不会因为改标题而崩。改文案只动这个文件。
 */
export const MODULE_COPY: Record<string, { short: string; en: string; blurb: string }> = {
  foundations: {
    short: '基础认知',
    en: 'Human Nature & Society',
    blurb: '人性与社会的底层规律——先看懂牌桌，再谈打法。',
  },
  thinking: {
    short: '思维工具',
    en: 'Thinking',
    blurb: '把复杂的问题拆开、看准、想透。',
  },
  execution: {
    short: '目标规划与执行',
    en: 'Execution',
    blurb: '从想清楚到做出来，中间那段路。',
  },
  decisions: {
    short: '决策能力',
    en: 'Decisions',
    blurb: '信息不全时，做出能承担的选择。',
  },
  relationships: {
    short: '处理关系',
    en: 'Relationships',
    blurb: '亲密关系与功利关系，各有各的分寸。',
  },
  resilience: {
    short: '心理能力',
    en: 'Resilience',
    blurb: '抵抗挫折，并且仍然觉得日子值得过。',
  },
};

export const MATURITY_LABEL: Record<Maturity, string> = {
  empty: '待建',
  stub: '起草',
  growing: '生长中',
  mature: '成文',
};

export interface DisplayModule extends ToolboxModule {
  short: string;
  en: string;
  blurb: string;
}

/** 把 vault 模块与站点文案合并，按索引排序。 */
export function displayModules(data: ToolboxData = toolbox): DisplayModule[] {
  return [...data.modules]
    .sort((a, b) => a.index - b.index)
    .map((module) => {
      const copy = MODULE_COPY[module.slug];
      return {
        ...module,
        short: copy?.short ?? module.name,
        en: copy?.en ?? '',
        blurb: copy?.blurb ?? '',
      };
    });
}

/** 数字加千分位。 */
export function formatChars(value: number): string {
  return value.toLocaleString('en-US');
}

export interface RadarAxis {
  index: number;
  slug: string;
  label: string;
  chars: number;
  weight: number;
  maturity: Maturity;
  angle: number;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'middle' | 'end';
}

export interface RadarGeometry {
  axes: RadarAxis[];
  polygon: string;
  rings: { radius: number; points: string }[];
  spokes: { x1: number; y1: number; x2: number; y2: number }[];
  radius: number;
}

/** 正多边形顶点（从正上方起，顺时针）。 */
function polygonPoints(radius: number, count: number): string {
  return Array.from({ length: count }, (_unused, index) => {
    const angle = (-90 + (360 / count) * index) * (Math.PI / 180);
    return `${(Math.cos(angle) * radius).toFixed(1)},${(Math.sin(angle) * radius).toFixed(1)}`;
  }).join(' ');
}

/**
 * 雷达图几何：六个方向各代表一个模块，半径代表内容量。
 *
 * 内容量为 0 的模块仍画在基础半径上——图的意义是「框架已经立起来了，
 * 哪一格还空着」，而不是「什么都没有」。所以永远保留一个可见的底环。
 */
export function radarGeometry(modules: DisplayModule[], radius = 116): RadarGeometry {
  const count = Math.max(modules.length, 3);
  const maxChars = Math.max(1, ...modules.map((module) => module.chars));
  const floor = 0.24;

  const axes: RadarAxis[] = modules.map((module, index) => {
    const angle = (-90 + (360 / count) * index) * (Math.PI / 180);
    const weight = module.chars === 0 ? 0 : Math.sqrt(module.chars / maxChars);
    const reach = radius * (floor + (1 - floor) * weight);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      index: module.index,
      slug: module.slug,
      label: module.short,
      chars: module.chars,
      weight,
      maturity: module.maturity,
      angle,
      x: Number((cos * reach).toFixed(1)),
      y: Number((sin * reach).toFixed(1)),
      labelX: Number((cos * (radius + 30)).toFixed(1)),
      labelY: Number((sin * (radius + 30)).toFixed(1)),
      anchor: cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle',
    };
  });

  return {
    axes,
    polygon: axes.map((axis) => `${axis.x},${axis.y}`).join(' '),
    rings: [0.4, 0.7, 1].map((ratio) => ({
      radius: radius * ratio,
      points: polygonPoints(radius * ratio, count),
    })),
    spokes: axes.map((axis) => ({
      x1: 0,
      y1: 0,
      x2: Number((Math.cos(axis.angle) * radius).toFixed(1)),
      y2: Number((Math.sin(axis.angle) * radius).toFixed(1)),
    })),
    radius,
  };
}
