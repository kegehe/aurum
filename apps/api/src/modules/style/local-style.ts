/**
 * 本地确定性样式分析（无 AI 降级路径）
 *
 * 当 AI 未配置或调用失败时使用，全部为本地计算、零成本：
 * - 颜色角色分配：频次 → 主色；亮度 → 背景；饱和度 → 强调色
 * - 颜色近似命名：内置常见色表 + 色相回退（深/浅前缀）
 * - 排版 / 布局 / 质感：按色板明度与饱和度的情绪推断出合理默认
 * - 布局变体：预置 4 套模板，用档案色板渲染，保证输出可落地
 *
 * 与 AI 路径共享 StyleProfile / StyleVariation 结构，前端无需区分。
 */
import { hexToRgb, relativeLuminance as luminance, type Rgb } from '../../common/color/contrast';
import type { ExtractedPalette } from './extractors/color-extractor';
import type { StyleProfile } from './types';

// ==================== 颜色工具 ====================
// hexToRgb / relativeLuminance 已抽到 common/color/contrast，与设计运营台的
// 对比度门禁共用一份实现（那边需要解析 rgb()/hsl()，这里只喂 hex）。

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * HSV 饱和度（0-1）
 *
 * 不用 HSL：HSL 在亮度接近极值时会严重高估饱和度（如近白色 #fff0f3
 * 与纯白仅差 6% 明度，HSL 却算出 1.0），导致强调色/情绪误判。
 * HSV 的 (max-min)/max 更符合"色彩的鲜艳程度"的直觉。
 */
function saturation(c: Rgb): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function rgbToHue(c: Rgb): number {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return toHex(A.r + (B.r - A.r) * t, A.g + (B.g - A.g) * t, A.b + (B.b - A.b) * t);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ==================== 颜色命名 ====================

/** 常见色名查找表（按 RGB 距离匹配） */
const COLOR_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['黑色', '#000000'],
  ['白色', '#ffffff'],
  ['灰色', '#9e9e9e'],
  ['银灰', '#c0c0c0'],
  ['深灰', '#424242'],
  ['红色', '#e53935'],
  ['深红', '#b71c1c'],
  ['珊瑚', '#ff7043'],
  ['橙色', '#f57c00'],
  ['琥珀', '#ffb300'],
  ['金色', '#d4af37'],
  ['黄色', '#fdd835'],
  ['橄榄', '#9e9d24'],
  ['绿色', '#43a047'],
  ['深绿', '#1b5e20'],
  ['薄荷', '#4db6ac'],
  ['青色', '#26c6da'],
  ['天蓝', '#29b6f6'],
  ['蓝色', '#1e88e5'],
  ['深蓝', '#0d47a1'],
  ['藏青', '#1a237e'],
  ['紫色', '#8e24aa'],
  ['紫罗兰', '#7c4dff'],
  ['洋红', '#ec407a'],
  ['粉色', '#f48fb1'],
  ['棕褐', '#6d4c41'],
  ['米色', '#d7ccc8'],
  ['青灰', '#607d8b'],
];

/** 色相家族 → 中文名 */
function hueFamily(h: number): string {
  if (h < 15 || h >= 345) return '红';
  if (h < 45) return '橙';
  if (h < 70) return '黄';
  if (h < 160) return '绿';
  if (h < 200) return '青';
  if (h < 250) return '蓝';
  if (h < 300) return '紫';
  return '粉';
}

/** 近似颜色名：内置色表最近邻 → 色相家族 + 深浅前缀 */
export function approxColorName(hex: string): string {
  const rgb = hexToRgb(hex);
  const lum = luminance(rgb);
  let best = '灰色';
  let bestDist = Infinity;
  for (const [name, h] of COLOR_NAMES) {
    const t = hexToRgb(h);
    const d = Math.sqrt((rgb.r - t.r) ** 2 + (rgb.g - t.g) ** 2 + (rgb.b - t.b) ** 2);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  // 距离足够近直接命中；否则用色相家族命名
  if (bestDist < 70) return best;
  const s = saturation(rgb);
  if (s < 0.08) {
    return lum > 0.92 ? '白色' : lum < 0.08 ? '黑色' : '灰色';
  }
  const prefix = lum > 0.7 ? '浅' : lum < 0.22 ? '深' : '';
  return prefix + hueFamily(rgbToHue(rgb));
}

// ==================== 角色分配与情绪 ====================

function assignRoles(colors: string[]): { primary: string; background: string; accent: string } {
  const list = colors.length ? colors : ['#212121', '#fafafa', '#2962ff'];
  const lums = list.map((c) => luminance(hexToRgb(c)));
  const sats = list.map((c) => saturation(hexToRgb(c)));
  const meanLum = avg(lums);
  const light = meanLum > 0.5;

  // 背景：亮图取最亮，暗图取最暗
  const bg = light ? lums.indexOf(Math.max(...lums)) : lums.indexOf(Math.min(...lums));
  // 主色：频次最高（colors[0]），避开背景
  let primary = 0;
  if (primary === bg && list.length > 1) primary = 1;
  // 强调色：饱和度最高，避开背景与主色
  let accent = sats.indexOf(Math.max(...sats));
  if ((accent === bg || accent === primary) && list.length > 2) {
    const ranked = sats
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => i !== bg && i !== primary)
      .sort((a, b) => b.s - a.s);
    if (ranked.length) accent = ranked[0].i;
  }
  // 防御：强调色与背景亮度差过小（如"白上加白"）时，改选与背景亮度差最大的候选色
  if (Math.abs(lums[accent] - lums[bg]) < 0.15) {
    const ranked = lums
      .map((l, i) => ({ d: Math.abs(l - lums[bg]), i }))
      .filter(({ i }) => i !== bg && i !== primary && i !== accent)
      .sort((a, b) => b.d - a.d);
    if (ranked.length && ranked[0].d > 0.15) accent = ranked[0].i;
  }

  return {
    primary: list[primary],
    background: list[bg],
    accent: list[accent],
  };
}

type Tone = 'dark' | 'vivid' | 'soft' | 'clean' | 'neutral';

function inferTone(colors: string[]): Tone {
  const sats = colors.map((c) => saturation(hexToRgb(c)));
  const lums = colors.map((c) => luminance(hexToRgb(c)));
  const meanSat = avg(sats);
  const meanLum = avg(lums);
  if (meanLum < 0.28) return 'dark';
  if (meanSat > 0.5) return 'vivid';
  if (meanSat < 0.18 && meanLum > 0.5) return 'soft';
  if (meanSat < 0.18) return 'clean';
  return 'neutral';
}

interface ToneSpec {
  familyTrait: string;
  suggestedFont: string;
  weights: number[];
  hierarchy: { role: string; sizePx: number; weight: number }[];
  lineHeight: number;
  radius: string;
  shadow: string;
  composition: string;
  balance: string;
  useCase: string;
  mood: string;
  keywords: string[];
}

const TONE_SPECS: Record<Tone, ToneSpec> = {
  dark: {
    familyTrait: '高对比几何无衬线',
    suggestedFont: 'Inter',
    weights: [400, 500, 600],
    hierarchy: [
      { role: 'display', sizePx: 56, weight: 700 },
      { role: 'heading', sizePx: 28, weight: 600 },
      { role: 'body', sizePx: 15, weight: 400 },
    ],
    lineHeight: 1.6,
    radius: '6px',
    shadow: '0 12px 32px rgba(0,0,0,0.28)',
    composition: '大留白的单栏布局，深色背景营造高级与沉浸感',
    balance: 'center',
    useCase: '高端品牌、沉浸式展示页、作品集',
    mood: '深邃沉稳，低明度基调',
    keywords: ['沉稳', '深邃', '高级'],
  },
  vivid: {
    familyTrait: '圆润现代无衬线',
    suggestedFont: 'Nunito Sans',
    weights: [400, 600, 800],
    hierarchy: [
      { role: 'display', sizePx: 52, weight: 800 },
      { role: 'heading', sizePx: 26, weight: 700 },
      { role: 'body', sizePx: 16, weight: 400 },
    ],
    lineHeight: 1.5,
    radius: '14px',
    shadow: '0 8px 24px rgba(0,0,0,0.12)',
    composition: '分区明确的通栏布局，彩色主色块与留白交错',
    balance: 'center',
    useCase: '活动推广、年轻化产品、电商 Banner',
    mood: '明快活泼，色彩鲜明',
    keywords: ['活泼', '明快', '高饱和'],
  },
  soft: {
    familyTrait: '衬线 / 宋体气质',
    suggestedFont: 'Noto Serif SC',
    weights: [400, 600],
    hierarchy: [
      { role: 'display', sizePx: 44, weight: 600 },
      { role: 'heading', sizePx: 24, weight: 600 },
      { role: 'body', sizePx: 16, weight: 400 },
    ],
    lineHeight: 1.8,
    radius: '16px',
    shadow: '0 6px 20px rgba(0,0,0,0.06)',
    composition: '简洁居中布局，柔和色块分区，信息层级清晰',
    balance: 'center',
    useCase: '内容平台、阅读类产品、生活方式品牌',
    mood: '温润自然，柔和舒适',
    keywords: ['自然', '舒适', '柔和'],
  },
  clean: {
    familyTrait: '现代无衬线',
    suggestedFont: 'Inter',
    weights: [400, 500, 700],
    hierarchy: [
      { role: 'display', sizePx: 48, weight: 700 },
      { role: 'heading', sizePx: 24, weight: 600 },
      { role: 'body', sizePx: 16, weight: 400 },
    ],
    lineHeight: 1.6,
    radius: '8px',
    shadow: 'none',
    composition: '简洁居中布局，大留白突出内容本身',
    balance: 'center',
    useCase: '工具类产品、B2B 官网、文档站点',
    mood: '素雅简约，大量留白',
    keywords: ['简约', '素雅', '留白'],
  },
  neutral: {
    familyTrait: '现代无衬线',
    suggestedFont: 'Inter',
    weights: [400, 500, 600],
    hierarchy: [
      { role: 'display', sizePx: 50, weight: 700 },
      { role: 'heading', sizePx: 26, weight: 600 },
      { role: 'body', sizePx: 16, weight: 400 },
    ],
    lineHeight: 1.6,
    radius: '10px',
    shadow: '0 8px 24px rgba(0,0,0,0.08)',
    composition: '通栏内容分区，标题与正文错落排布',
    balance: 'center',
    useCase: '通用 Web 应用、管理后台、门户',
    mood: '现代简洁，干净利落',
    keywords: ['现代', '简洁'],
  },
};

const DENSITY_LABELS: Record<StyleProfile['spacing']['density'], string> = {
  compact: '紧凑',
  comfortable: '舒适',
  loose: '宽松',
};

// ==================== 档案生成 ====================

/**
 * 从像素提取的色板生成完整 StyleProfile（无 AI）。
 * 颜色严格来自输入色板，其余字段为启发式合理默认。
 */
export function buildLocalProfile(palette: ExtractedPalette): StyleProfile {
  const colors = palette.colors.length ? palette.colors : ['#212121', '#fafafa', '#2962ff'];
  const roles = assignRoles(colors);
  const tone = inferTone(colors);
  const spec = TONE_SPECS[tone];
  const density: StyleProfile['spacing']['density'] =
    colors.length > 8 ? 'compact' : colors.length > 5 ? 'comfortable' : 'loose';

  const primary = { hex: roles.primary, role: '主色', approxName: approxColorName(roles.primary) };
  const background = {
    hex: roles.background,
    role: '背景',
    approxName: approxColorName(roles.background),
  };
  const accent = { hex: roles.accent, role: '强调色', approxName: approxColorName(roles.accent) };

  // 强调色与主色/背景明度差足够大时才建议渐变，避免无意义渐变
  const lumA = luminance(hexToRgb(roles.accent));
  const lumP = luminance(hexToRgb(roles.primary));
  const gradient =
    Math.abs(lumA - lumP) > 0.15
      ? `linear-gradient(135deg, ${roles.primary}, ${roles.accent})`
      : null;

  const styleGuideText =
    `以 ${primary.hex}（${primary.approxName}）为基调、${background.hex}（${background.approxName}）` +
    `为底色、${accent.hex}（${accent.approxName}）作强调的配色方案。整体${spec.mood}；` +
    `${DENSITY_LABELS[density]}的间距节奏配合${spec.familyTrait}字体，营造统一而有层次的视觉系统。` +
    `适合${spec.useCase}。此档案由本地确定性分析生成，色板取自图片像素，数值可直接用于落地。`;

  return {
    colorPalette: {
      primary,
      background,
      accent,
      scale: colors,
      mood: spec.mood,
    },
    typography: {
      familyTrait: spec.familyTrait,
      suggestedFont: spec.suggestedFont,
      weights: spec.weights,
      hierarchy: spec.hierarchy.map((h) => ({
        ...h,
        letterSpacing: h.role === 'display' ? '-0.02em' : undefined,
        weight: h.weight,
      })),
      lineHeight: spec.lineHeight,
    },
    spacing: {
      unit: 8,
      scale: [4, 8, 16, 24, 48],
      density,
    },
    layout: {
      composition: spec.composition,
      regions: ['header', 'content', 'footer'],
      grid: { columns: 12, gutterPx: 24 },
      balance: spec.balance,
    },
    textureMood: {
      radius: spec.radius,
      shadow: spec.shadow,
      gradient,
      density,
      keywords: spec.keywords,
    },
    styleGuideText,
  };
}

// ==================== 布局变体模板 ====================

/** 变体模板需要的已计算 CSS 变量 */
interface TemplateVars {
  bg: string;
  primary: string;
  accent: string;
  text: string;
  surface: string;
  border: string;
  radius: string;
  shadow: string;
  font: string;
  lineHeight: string;
}

function readableTextOn(bg: string): string {
  return luminance(hexToRgb(bg)) > 0.5 ? mixHex(bg, '#000000', 0.85) : mixHex(bg, '#ffffff', 0.92);
}

function surfaceOn(bg: string): string {
  return luminance(hexToRgb(bg)) > 0.5 ? mixHex(bg, '#ffffff', 0.75) : mixHex(bg, '#ffffff', 0.1);
}

function fontStack(profile: StyleProfile): string {
  const t = profile.typography.familyTrait.toLowerCase();
  // 注意："无衬线" 含子串 "衬线"，必须先判断 无衬线/sans，再判断 衬线/serif
  if (t.includes('无衬线') || t.includes('sans')) {
    return `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  }
  if (t.includes('衬线') || t.includes('serif')) {
    return `Georgia, 'Songti SC', 'SimSun', serif`;
  }
  if (t.includes('等宽') || t.includes('mono')) {
    return `ui-monospace, 'Cascadia Mono', Consolas, monospace`;
  }
  return `system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`;
}

function templateVars(profile: StyleProfile): TemplateVars {
  const p = profile.colorPalette;
  const bg = p.background.hex;
  const text = readableTextOn(bg);
  const surface = surfaceOn(bg);
  return {
    bg,
    primary: p.primary.hex,
    accent: p.accent.hex,
    text,
    surface,
    border: mixHex(text, bg, 0.55),
    radius: profile.textureMood.radius,
    shadow: profile.textureMood.shadow,
    font: fontStack(profile),
    lineHeight: String(profile.typography.lineHeight),
  };
}

const TPL_CSS = (v: TemplateVars) =>
  `:root{--bg:${v.bg};--primary:${v.primary};--accent:${v.accent};--text:${v.text};--surface:${v.surface};--border:${v.border};--radius:${v.radius};--shadow:${v.shadow};--font:${v.font};--lh:${v.lineHeight}}`;

function heroTemplate(v: TemplateVars): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${TPL_CSS(v)}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:var(--lh)}
nav{display:flex;align-items:center;justify-content:space-between;padding:14px 40px;border-bottom:1px solid var(--border)}
.brand{font-weight:700}.nav a{margin-left:20px;font-size:13px;opacity:.75;text-decoration:none;color:inherit}
.hero{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:110px 24px 90px;gap:18px}
.hero h1{font-size:56px;line-height:1.1;letter-spacing:-.02em;margin:0}
.hero p{max-width:520px;font-size:17px;opacity:.75;margin:0}
.cta{background:var(--accent);color:#fff;border:none;border-radius:var(--radius);padding:13px 34px;font-size:16px;cursor:pointer}
.dots{display:flex;gap:8px;margin-top:34px}.dots span{width:36px;height:36px;border-radius:var(--radius)}
</style></head><body>
<nav><span class="brand">品牌</span><div class="nav"><a>功能</a><a>案例</a><a>定价</a><a>关于</a></div></nav>
<section class="hero"><h1>大标题文案</h1><p>一句副标题，概括产品核心价值并引导用户继续浏览。</p><button class="cta">开始使用</button>
<div class="dots"><span style="background:var(--primary)"></span><span style="background:var(--accent)"></span><span style="background:var(--surface)"></span></div></section>
</body></html>`;
}

function cardFeedTemplate(v: TemplateVars): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${TPL_CSS(v)}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:var(--lh)}
.head{max-width:1080px;margin:0 auto;padding:34px 24px 6px}.head h1{margin:0;font-size:28px}.head p{margin:6px 0 0;font-size:14px;opacity:.7}
.grid{max-width:1080px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.thumb{height:110px;border-radius:calc(var(--radius) - 4px);margin-bottom:14px}
.card h3{margin:0 0 6px;font-size:16px}.card p{margin:0;font-size:13px;opacity:.7}
</style></head><body>
<header class="head"><h1>内容标题</h1><p>列表概览副标题，说明页面用途。</p></header>
<main class="grid">
  <div class="card"><div class="thumb" style="background:var(--primary)"></div><h3>卡片一</h3><p>占位描述文字。</p></div>
  <div class="card"><div class="thumb" style="background:var(--accent)"></div><h3>卡片二</h3><p>占位描述文字。</p></div>
  <div class="card"><div class="thumb" style="background:var(--surface);border:1px solid var(--border)"></div><h3>卡片三</h3><p>占位描述文字。</p></div>
  <div class="card"><div class="thumb" style="background:var(--primary);opacity:.55"></div><h3>卡片四</h3><p>占位描述文字。</p></div>
</main>
</body></html>`;
}

function splitPanelTemplate(v: TemplateVars): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${TPL_CSS(v)}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:var(--lh);display:flex;min-height:100vh}
aside{width:200px;border-right:1px solid var(--border);padding:22px 16px;display:flex;flex-direction:column;gap:18px}
.logo{font-weight:700;margin-bottom:8px}.menu{display:flex;flex-direction:column;gap:4px}
.menu a{padding:8px 12px;border-radius:calc(var(--radius) - 4px);font-size:13px;text-decoration:none;color:inherit;opacity:.7}
.menu a.on{background:var(--primary);color:#fff;opacity:1}
main{flex:1;padding:34px 40px}.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:26px}
.toolbar h1{margin:0;font-size:22px}.btn{background:var(--accent);color:#fff;border:none;border-radius:var(--radius);padding:9px 18px;font-size:13px;cursor:pointer}
.panels{display:grid;grid-template-columns:2fr 1fr;gap:16px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
.panel h3{margin:0 0 8px;font-size:14px}.bar{height:10px;border-radius:6px;background:var(--border);margin-top:10px}
.bar.p{background:var(--primary)}.bar.a{background:var(--accent)}
</style></head><body>
<aside><div class="logo">产品名</div><div class="menu"><a class="on">概览</a><a>数据</a><a>设置</a><a>成员</a></div></aside>
<main><div class="toolbar"><h1>概览</h1><button class="btn">新建</button></div>
<div class="panels">
  <div class="panel"><h3>主要指标</h3><div class="bar p" style="width:80%"></div><div class="bar a" style="width:55%"></div><div class="bar" style="width:32%"></div></div>
  <div class="panel"><h3>说明</h3><p style="font-size:13px;opacity:.75">占位文案，用于展示侧边栏与内容区组合的信息密度。</p></div>
</div></main>
</body></html>`;
}

function editorialGridTemplate(v: TemplateVars): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${TPL_CSS(v)}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:var(--lh)}
.wrap{max-width:1040px;margin:0 auto;padding:40px 24px}
.lead{display:grid;grid-template-columns:1.2fr 1fr;gap:22px;margin-bottom:22px}
.lead .cover{height:260px;border-radius:var(--radius);background:var(--primary)}
.lead h1{margin:0 0 10px;font-size:30px;line-height:1.2}.lead p{margin:0;font-size:14px;opacity:.75}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.tile{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface);box-shadow:var(--shadow)}
.tile .timg{height:90px}.tile h3{margin:10px 14px 4px;font-size:14px}.tile p{margin:0 14px 12px;font-size:12px;opacity:.7}
</style></head><body>
<div class="wrap">
<section class="lead"><div class="cover"></div><div><h1>头条大标题</h1><p>编辑风格的重点内容引言，突出主要信息与视觉重心。</p></div></section>
<section class="tiles">
  <div class="tile"><div class="timg" style="background:var(--accent)"></div><h3>条目一</h3><p>简短描述。</p></div>
  <div class="tile"><div class="timg" style="background:var(--primary);opacity:.6"></div><h3>条目二</h3><p>简短描述。</p></div>
  <div class="tile"><div class="timg" style="background:var(--surface);border-bottom:1px solid var(--border)"></div><h3>条目三</h3><p>简短描述。</p></div>
</section>
</div>
</body></html>`;
}

interface LocalVariation {
  name: string;
  description: string;
  composition: string;
  html: string;
}

/** 本地布局变体模板库：不同构图、同一套样式 token */
export function buildLocalVariations(profile: StyleProfile): LocalVariation[] {
  const v = templateVars(profile);
  return [
    {
      name: '居中 Hero 落地页',
      description: '大标题居中，CTA 引导，适合落地页',
      composition: '居中大标题 hero，顶部细导航，底部主色与强调色色块点缀',
      html: heroTemplate(v),
    },
    {
      name: '卡片信息流',
      description: '通栏头部 + 响应式卡片网格',
      composition: '顶部通栏头部，下方响应式卡片网格，主色/强调色交替作为卡片视觉锚点',
      html: cardFeedTemplate(v),
    },
    {
      name: '侧边栏工作台',
      description: '左侧导航 + 右侧内容区',
      composition: '左侧固定导航栏，右侧内容区，强调色按钮与主色选中态形成主次关系',
      html: splitPanelTemplate(v),
    },
    {
      name: '杂志式网格',
      description: '头条大图 + 错落小卡片',
      composition: '大图头条置顶，正文与视觉并重，下方错落小卡片网格',
      html: editorialGridTemplate(v),
    },
  ];
}
