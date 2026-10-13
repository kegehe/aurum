/**
 * 效果配方库。
 *
 * 存在的理由：模型凭自由发挥写出的 CSS 是合格的，但不是出色的。让它做"玻璃拟态"，
 * 它常常只给一个半透明背景，想不到 `backdrop-filter` + 内高光 + 半透明边框这套
 * 三件套。这里把"什么样的组合才像样"写成明文，作为参考知识注入提示词；同时
 * 它们也是空对话页上的"试试这些"芯片——避免用户面对空白输入框发懵。
 *
 * 每个配方都带一份**可校验的样例**：`sample` 产出的内容必须同时通过
 * `validateDesignContent` 与发布门禁（见 design-recipes.spec.ts）。这是刻意
 * 加的约束——配方的价值就在于"它真的能发布"，写错一个属性名就白搭。
 */
import type { TokenTable } from './design-css';
import type { DesignKind, JsonRecord } from './design.types';

export type RecipeCategory = 'palette' | 'button' | 'card' | 'text' | 'motion';

export interface DesignRecipe {
  id: string;
  name: string;
  /** 一句话说清"什么时候用它"。也是提示词芯片上的文案。 */
  blurb: string;
  category: RecipeCategory;
  kind: DesignKind;
  /** 工法要点：为什么这个组合好看。注入提示词的就是这一段。 */
  technique: string;
  /** 可校验样例。不含 `dependencies`——主题版本由调用方钉。 */
  sample: (tokens: TokenTable) => JsonRecord;
}

/**
 * 引用主题 token，缺失时退回字面量。
 *
 * 这样配方对**任何**主题都能用：用户的主题里没有 `radius.md` 时，效果不会整个
 * 塌掉，只是那一个值不再是可换肤的。比"整套配方假设一套固定 token 命名"稳得多。
 */
function use(tokens: TokenTable, path: string, fallback: string): string {
  return tokens.has(path) ? `{${path}}` : fallback;
}

function shadow(offsetY: string, blur: string, color: string, spread = '0px'): JsonRecord {
  return { offsetX: '0px', offsetY, blur, spread, color };
}

function component(input: {
  type: string;
  appliesTo?: 'element' | 'container' | 'text';
  variants: JsonRecord;
}): JsonRecord {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: input.type,
    appliesTo: input.appliesTo ?? 'element',
    variants: input.variants,
  };
}

function animation(input: {
  type: string;
  trigger: string;
  keyframes: JsonRecord[];
  duration: string;
  easing: string;
  reducedMotion: JsonRecord;
}): JsonRecord {
  return {
    schemaVersion: 'aurum.animation.v1',
    animationType: input.type,
    trigger: input.trigger,
    keyframes: input.keyframes,
    timing: { duration: input.duration, easing: input.easing, fillMode: 'both' },
    reducedMotion: { declarations: input.reducedMotion },
  };
}

function palette(input: {
  primary: string;
  strong: string;
  page: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  radius: [string, string, string];
}): JsonRecord {
  const [small, medium, large] = input.radius;
  return {
    tokenSchemaVersion: 'aurum.tokens.v1',
    tokens: {
      color: {
        primary: { $type: 'color', $value: input.primary },
        'primary-strong': { $type: 'color', $value: input.strong },
        'on-primary': { $type: 'color', $value: '#ffffff' },
        page: { $type: 'color', $value: input.page },
        surface: { $type: 'color', $value: input.surface },
        border: { $type: 'color', $value: input.border },
        text: { $type: 'color', $value: input.text },
        muted: { $type: 'color', $value: input.muted },
      },
      space: {
        sm: { $type: 'dimension', $value: '8px' },
        md: { $type: 'dimension', $value: '12px' },
        lg: { $type: 'dimension', $value: '20px' },
      },
      radius: {
        sm: { $type: 'dimension', $value: small },
        md: { $type: 'dimension', $value: medium },
        lg: { $type: 'dimension', $value: large },
        full: { $type: 'dimension', $value: '999px' },
      },
      duration: {
        fast: { $type: 'duration', $value: '150ms' },
        normal: { $type: 'duration', $value: '300ms' },
      },
      easing: { out: { $type: 'cubicBezier', $value: [0.16, 1, 0.3, 1] } },
      shadow: {
        card: {
          $type: 'shadow',
          $value: {
            offsetX: '0px',
            offsetY: '10px',
            blur: '28px',
            spread: '-10px',
            color: 'rgba(15, 23, 42, 0.22)',
          },
        },
      },
    },
  };
}

export const RECIPES: DesignRecipe[] = [
  // ==================== 配色 ====================
  {
    id: 'palette-indigo',
    name: '靛蓝商务',
    blurb: '后台管理、数据密集型界面的安全选择',
    category: 'palette',
    kind: 'theme',
    technique: '冷色主色压住大面积白底，正文用近黑的深蓝而不是纯黑，避免默认界面那种发灰的观感。',
    sample: () =>
      palette({
        primary: '#1f6feb',
        strong: '#1450b3',
        page: '#f7f9fc',
        surface: '#ffffff',
        border: '#d8e0ea',
        text: '#0f172a',
        muted: '#5b6b7f',
        radius: ['4px', '10px', '18px'],
      }),
  },
  {
    id: 'palette-graphite',
    name: '石墨中性',
    blurb: '内容为主、不想让界面抢戏',
    category: 'palette',
    kind: 'theme',
    technique: '主色饱和度压低到接近中性，靠层级和间距而不是颜色建立秩序，适合长时间阅读。',
    sample: () =>
      palette({
        primary: '#3f4a5a',
        strong: '#242c38',
        page: '#fafafa',
        surface: '#ffffff',
        border: '#e2e5ea',
        text: '#16181d',
        muted: '#6b7280',
        radius: ['2px', '6px', '12px'],
      }),
  },
  {
    id: 'palette-teal',
    name: '深海青',
    blurb: '工具类、开发者向产品，带一点科技感',
    category: 'palette',
    kind: 'theme',
    technique:
      '青绿主色配极浅的青灰背景，冷而不冰；圆角给足，抵消青色本身偏硬的观感。主色刻意压深一档：原来的 #0d9488 配白字只有 3.74:1，过不了 AA。',
    sample: () =>
      palette({
        // #0e7c72 而不是 #0d9488：后者配白色文字实测只有 3.74:1，会被门禁拦下
        primary: '#0e7c72',
        strong: '#0f766e',
        page: '#f4faf9',
        surface: '#ffffff',
        border: '#cfe6e2',
        text: '#0c1f1d',
        muted: '#5c7a76',
        radius: ['6px', '12px', '20px'],
      }),
  },

  // ==================== 按钮 ====================
  {
    id: 'button-gradient',
    name: '渐变主按钮',
    blurb: '页面上最重要的那个操作',
    category: 'button',
    kind: 'component',
    technique:
      '135° 双色渐变（主色→深一档）比纯色更有厚度；配一层短距离外阴影把按钮从背景上托起来，悬停时上移 1px 并加深阴影，产生可按的错觉。',
    sample: (tokens) =>
      component({
        type: 'btn-gradient',
        variants: {
          default: {
            declarations: {
              'background-image': `linear-gradient(135deg, ${use(tokens, 'color.primary', '#1f6feb')} 0%, ${use(tokens, 'color.primary-strong', '#1450b3')} 100%)`,
              color: use(tokens, 'color.on-primary', '#ffffff'),
              'border-style': 'none',
              'border-radius': use(tokens, 'radius.md', '10px'),
              padding: `${use(tokens, 'space.sm', '8px')} ${use(tokens, 'space.lg', '20px')}`,
              'font-weight': '600',
              'box-shadow': [shadow('2px', '10px', 'rgba(20, 80, 179, 0.30)')],
              'transition-duration': use(tokens, 'duration.fast', '150ms'),
              'transition-timing-function': 'ease-out',
            },
            states: {
              hover: {
                transform: 'translateY(-1px)',
                'box-shadow': [shadow('6px', '18px', 'rgba(20, 80, 179, 0.38)')],
              },
              'focus-visible': {
                outline: `2px solid ${use(tokens, 'color.primary-strong', '#1450b3')}`,
                'outline-offset': '2px',
              },
              disabled: { opacity: '0.5', 'box-shadow': 'none' },
            },
          },
        },
      }),
  },
  {
    id: 'button-glass',
    name: '玻璃按钮',
    blurb: '浮在图片或渐变上，不能糊成一团',
    category: 'button',
    kind: 'component',
    technique:
      '半透明底 + backdrop-filter 磨砂 + 一圈更亮的半透明描边。三者缺一不可：只有半透明底会糊，只有描边会像线框。',
    sample: (tokens) =>
      component({
        type: 'btn-glass',
        variants: {
          default: {
            declarations: {
              'background-color': 'rgba(255, 255, 255, 0.18)',
              'backdrop-filter': 'blur(12px) saturate(140%)',
              border: `1px solid ${use(tokens, 'color.border', 'rgba(255, 255, 255, 0.42)')}`,
              'border-radius': use(tokens, 'radius.full', '999px'),
              padding: `${use(tokens, 'space.sm', '8px')} ${use(tokens, 'space.lg', '20px')}`,
              color: use(tokens, 'color.text', '#0f172a'),
              'font-weight': '600',
              'transition-duration': use(tokens, 'duration.fast', '150ms'),
            },
            states: {
              hover: { 'background-color': 'rgba(255, 255, 255, 0.30)' },
              'focus-visible': {
                outline: `2px solid ${use(tokens, 'color.primary', '#1f6feb')}`,
                'outline-offset': '2px',
              },
            },
          },
        },
      }),
  },
  {
    id: 'button-outline',
    name: '描边按钮',
    blurb: '次级操作，不想抢主按钮的注意力',
    category: 'button',
    kind: 'component',
    technique: '细描边 + 透明底，悬停时底色淡淡铺开而不是整块变色，动作比主按钮克制一档。',
    sample: (tokens) =>
      component({
        type: 'btn-outline',
        variants: {
          default: {
            declarations: {
              'background-color': 'transparent',
              border: `1px solid ${use(tokens, 'color.border', '#d8e0ea')}`,
              color: use(tokens, 'color.text', '#0f172a'),
              'border-radius': use(tokens, 'radius.md', '10px'),
              padding: `${use(tokens, 'space.sm', '8px')} ${use(tokens, 'space.lg', '20px')}`,
              'transition-duration': use(tokens, 'duration.fast', '150ms'),
            },
            states: {
              hover: {
                'background-color': use(tokens, 'color.surface', '#ffffff'),
                'border-color': use(tokens, 'color.primary', '#1f6feb'),
              },
              'focus-visible': {
                outline: `2px solid ${use(tokens, 'color.primary', '#1f6feb')}`,
                'outline-offset': '2px',
              },
            },
          },
        },
      }),
  },
  {
    id: 'button-glow',
    name: '发光按钮',
    blurb: '想让某个按钮在深色界面里"亮起来"',
    category: 'button',
    kind: 'component',
    technique:
      '纯色底 + 与主色同色的外发光（大 blur、零偏移），悬停时把发光半径推大一倍。发光色必须和底色同源，否则会显得脏。',
    sample: (tokens) =>
      component({
        type: 'btn-glow',
        variants: {
          default: {
            declarations: {
              'background-color': use(tokens, 'color.primary', '#1f6feb'),
              color: use(tokens, 'color.on-primary', '#ffffff'),
              'border-style': 'none',
              'border-radius': use(tokens, 'radius.full', '999px'),
              padding: `${use(tokens, 'space.sm', '8px')} ${use(tokens, 'space.lg', '20px')}`,
              'font-weight': '600',
              'box-shadow': [shadow('0px', '18px', 'rgba(31, 111, 235, 0.55)')],
              'transition-duration': use(tokens, 'duration.normal', '300ms'),
            },
            states: {
              hover: { 'box-shadow': [shadow('0px', '32px', 'rgba(31, 111, 235, 0.75)')] },
              'focus-visible': {
                outline: `2px solid ${use(tokens, 'color.on-primary', '#ffffff')}`,
                'outline-offset': '3px',
              },
            },
          },
        },
      }),
  },

  // ==================== 卡片 ====================
  {
    id: 'card-glass',
    name: '玻璃拟态卡片',
    blurb: '叠在图片或彩色背景上的信息卡',
    category: 'card',
    kind: 'component',
    technique:
      '磨砂底 + 左上角内高光（::before 的白色渐变）+ 半透明描边。内高光是最容易被忘掉的一层，没有它就没有"玻璃"的厚度感。',
    sample: (tokens) =>
      component({
        type: 'glass-card',
        appliesTo: 'container',
        variants: {
          default: {
            declarations: {
              'background-color': 'rgba(255, 255, 255, 0.14)',
              'backdrop-filter': 'blur(18px) saturate(160%)',
              border: '1px solid rgba(255, 255, 255, 0.35)',
              'border-radius': use(tokens, 'radius.lg', '18px'),
              padding: use(tokens, 'space.lg', '20px'),
              'box-shadow': [shadow('16px', '40px', 'rgba(15, 23, 42, 0.28)', '-12px')],
              overflow: 'hidden',
              position: 'relative',
            },
            pseudo: {
              before: {
                content: '""',
                position: 'absolute',
                inset: '0px',
                'background-image':
                  'linear-gradient(150deg, rgba(255, 255, 255, 0.42) 0%, rgba(255, 255, 255, 0) 52%)',
                'border-radius': use(tokens, 'radius.lg', '18px'),
              },
            },
          },
        },
      }),
  },
  {
    id: 'card-lift',
    name: '悬浮抬升卡片',
    blurb: '列表里可以被点开的卡片',
    category: 'card',
    kind: 'component',
    technique:
      '静态时用一层较大的软阴影定住层次，悬停时上移 4px、阴影收紧变深。阴影的铺开半径要随位移一起收，否则会像飘起来而不是抬起来。',
    sample: (tokens) =>
      component({
        type: 'lift-card',
        appliesTo: 'container',
        variants: {
          default: {
            declarations: {
              'background-color': use(tokens, 'color.surface', '#ffffff'),
              border: `1px solid ${use(tokens, 'color.border', '#d8e0ea')}`,
              'border-radius': use(tokens, 'radius.lg', '18px'),
              padding: use(tokens, 'space.lg', '20px'),
              'box-shadow': [shadow('4px', '16px', 'rgba(15, 23, 42, 0.10)', '-8px')],
              'transition-duration': use(tokens, 'duration.normal', '300ms'),
              'transition-timing-function': 'ease-out',
            },
            states: {
              hover: {
                transform: 'translateY(-4px)',
                'box-shadow': [shadow('14px', '32px', 'rgba(15, 23, 42, 0.16)', '-12px')],
              },
              'focus-visible': {
                outline: `2px solid ${use(tokens, 'color.primary', '#1f6feb')}`,
                'outline-offset': '2px',
              },
            },
          },
        },
      }),
  },
  {
    id: 'card-gradient-border',
    name: '渐变边框卡片',
    blurb: '需要一点彩色但不想整块上色',
    category: 'card',
    kind: 'component',
    technique:
      'CSS 没有渐变 border，所以用 ::before 铺一层渐变、垫到元素背后（z-index: -1）当描边。要求元素自己没有实色底，否则渐变会被盖住。',
    sample: (tokens) =>
      component({
        type: 'gradient-border-card',
        appliesTo: 'container',
        variants: {
          default: {
            declarations: {
              'background-color': 'transparent',
              'border-radius': use(tokens, 'radius.lg', '18px'),
              padding: use(tokens, 'space.lg', '20px'),
              position: 'relative',
              'box-shadow': [shadow('12px', '28px', 'rgba(15, 23, 42, 0.14)', '-14px')],
            },
            pseudo: {
              before: {
                content: '""',
                position: 'absolute',
                inset: '-1px',
                'background-image': `linear-gradient(135deg, ${use(tokens, 'color.primary', '#1f6feb')} 0%, rgba(255, 255, 255, 0) 60%)`,
                'border-radius': use(tokens, 'radius.lg', '18px'),
                'z-index': '-1',
              },
            },
          },
        },
      }),
  },
  {
    id: 'card-sheen',
    name: '高光扫过卡片',
    blurb: '需要吸引注意力的推荐位',
    category: 'card',
    kind: 'component',
    technique:
      '一个斜向的白色渐变条用 ::before 铺在卡片上，平时挪到框外，悬停时扫过。必须给容器 overflow: hidden，否则高光会溢到卡片外面。',
    sample: (tokens) =>
      component({
        type: 'sheen-card',
        appliesTo: 'container',
        variants: {
          default: {
            declarations: {
              'background-color': use(tokens, 'color.surface', '#ffffff'),
              'border-radius': use(tokens, 'radius.lg', '18px'),
              padding: use(tokens, 'space.lg', '20px'),
              overflow: 'hidden',
              position: 'relative',
              'box-shadow': [shadow('10px', '24px', 'rgba(15, 23, 42, 0.12)', '-12px')],
              'transition-duration': use(tokens, 'duration.normal', '300ms'),
            },
            pseudo: {
              before: {
                content: '""',
                position: 'absolute',
                top: '0px',
                left: '-60%',
                width: '40%',
                height: '100%',
                'background-image':
                  'linear-gradient(100deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.65) 50%, rgba(255, 255, 255, 0) 100%)',
                'transition-duration': use(tokens, 'duration.normal', '300ms'),
              },
            },
            states: {
              hover: { 'background-color': use(tokens, 'color.page', '#f7f9fc') },
            },
          },
        },
      }),
  },
  {
    id: 'card-layered-shadow',
    name: '分层阴影卡片',
    blurb: '想要"实心放在桌面上"的物理感',
    category: 'card',
    kind: 'component',
    technique:
      '三层阴影叠加：贴边一层紧的定轮廓，中间一层中距离，最外一层大范围低透明压环境。一层阴影永远做不出这种重量感。',
    sample: (tokens) =>
      component({
        type: 'layered-card',
        appliesTo: 'container',
        variants: {
          default: {
            declarations: {
              'background-color': use(tokens, 'color.surface', '#ffffff'),
              'border-radius': use(tokens, 'radius.lg', '18px'),
              padding: use(tokens, 'space.lg', '20px'),
              'box-shadow': [
                shadow('1px', '2px', 'rgba(15, 23, 42, 0.08)'),
                shadow('6px', '12px', 'rgba(15, 23, 42, 0.08)', '-2px'),
                shadow('20px', '40px', 'rgba(15, 23, 42, 0.12)', '-12px'),
              ],
            },
          },
        },
      }),
  },

  // ==================== 文字 ====================
  {
    id: 'text-gradient',
    name: '渐变文字',
    blurb: '大标题，想让一句主文案有记忆点',
    category: 'text',
    kind: 'component',
    technique:
      '背景渐变 + background-clip: text + color: transparent 三者是一组，缺一个就看不见字。只适合大字号，小字会糊。',
    sample: (tokens) =>
      component({
        type: 'gradient-heading',
        appliesTo: 'text',
        variants: {
          default: {
            declarations: {
              'background-image': `linear-gradient(120deg, ${use(tokens, 'color.primary', '#1f6feb')} 0%, ${use(tokens, 'color.primary-strong', '#1450b3')} 100%)`,
              'background-clip': 'text',
              color: 'transparent',
              'font-size': '32px',
              'font-weight': '700',
              'line-height': '1.25',
            },
          },
        },
      }),
  },
  {
    id: 'text-glow',
    name: '发光标题',
    blurb: '深色背景上的标题',
    category: 'text',
    kind: 'component',
    technique:
      '同色文字 + 一到两层 text-shadow 光晕（一近一远）。远层透明度要低，否则字会糊成一团。',
    sample: (tokens) =>
      component({
        type: 'glow-heading',
        appliesTo: 'text',
        variants: {
          default: {
            declarations: {
              color: use(tokens, 'color.primary', '#1f6feb'),
              'font-size': '28px',
              'font-weight': '700',
              'text-shadow': [
                shadow('0px', '6px', 'rgba(31, 111, 235, 0.55)'),
                shadow('0px', '22px', 'rgba(31, 111, 235, 0.28)'),
              ],
            },
          },
        },
      }),
  },
  {
    id: 'text-underline',
    name: '强调下划线',
    blurb: '正文里的强调，或者可点的链接',
    category: 'text',
    kind: 'component',
    technique:
      '用 ::after 画一条下划线而不是 text-decoration，这样能控制粗细、偏移和颜色；悬停时把宽度从 40% 展开到 100%。',
    sample: (tokens) =>
      component({
        type: 'accent-underline',
        appliesTo: 'text',
        variants: {
          default: {
            declarations: {
              color: use(tokens, 'color.text', '#0f172a'),
              position: 'relative',
              'font-weight': '600',
              padding: '0px 0px 4px',
              'transition-duration': use(tokens, 'duration.fast', '150ms'),
            },
            pseudo: {
              after: {
                content: '""',
                position: 'absolute',
                left: '0px',
                bottom: '0px',
                width: '40%',
                height: '2px',
                'background-color': use(tokens, 'color.primary', '#1f6feb'),
                'border-radius': use(tokens, 'radius.full', '999px'),
                'transition-duration': use(tokens, 'duration.fast', '150ms'),
              },
            },
            states: {
              hover: { color: use(tokens, 'color.primary', '#1f6feb') },
            },
          },
        },
      }),
  },

  // ==================== 动效 ====================
  {
    id: 'motion-fade-slide',
    name: '淡入上移',
    blurb: '内容进场，最不容易出错的一个',
    category: 'motion',
    kind: 'animation',
    technique:
      '透明度 0→1 配 12px 的上移，距离必须小：位移一大，慢速设备上会看出卡顿。缓动用 ease-out（快进慢出），符合"物体减速停下"的直觉。',
    sample: (tokens) =>
      animation({
        type: 'fade-slide-in',
        trigger: 'on-enter',
        keyframes: [
          { at: 'from', declarations: { opacity: '0', transform: 'translateY(12px)' } },
          { at: 'to', declarations: { opacity: '1', transform: 'translateY(0px)' } },
        ],
        duration: use(tokens, 'duration.normal', '300ms'),
        easing: 'ease-out',
        reducedMotion: { opacity: '1', transform: 'translateY(0px)' },
      }),
  },
  {
    id: 'motion-pop',
    name: '弹性缩放进入',
    blurb: '弹窗、徽标、需要"跳出来"的元素',
    category: 'motion',
    kind: 'animation',
    technique:
      '从 0.92 开始（不是 0，从 0 放大像炸开），冲过 1.02 再回到 1。过冲让弹簧感成立，但幅度超过 1.05 就显得廉价。',
    sample: (tokens) =>
      animation({
        type: 'pop-in',
        trigger: 'on-enter',
        keyframes: [
          { at: 'from', declarations: { opacity: '0', transform: 'scale(0.92)' } },
          { at: '65%', declarations: { opacity: '1', transform: 'scale(1.02)' } },
          { at: 'to', declarations: { opacity: '1', transform: 'scale(1)' } },
        ],
        duration: use(tokens, 'duration.normal', '300ms'),
        easing: 'ease-out',
        reducedMotion: { opacity: '1', transform: 'scale(1)' },
      }),
  },
  {
    id: 'motion-pulse',
    name: '呼吸脉冲',
    blurb: '提示"这里在等着你操作"',
    category: 'motion',
    kind: 'animation',
    technique:
      '不透明度在 0.5×–1× 之间来回，中段放到最亮形成呼吸感。别用 scale 做脉冲——会推着周围元素抖动。',
    sample: (tokens) =>
      animation({
        type: 'breathing-pulse',
        trigger: 'continuous',
        keyframes: [
          { at: 'from', declarations: { opacity: '1' } },
          { at: '50%', declarations: { opacity: '0.55' } },
          { at: 'to', declarations: { opacity: '1' } },
        ],
        duration: use(tokens, 'duration.normal', '300ms'),
        easing: 'ease-in-out',
        reducedMotion: { opacity: '1' },
      }),
  },
  {
    id: 'motion-shimmer',
    name: '骨架微光',
    blurb: '加载占位的扫光',
    category: 'motion',
    kind: 'animation',
    technique:
      '背景渐变的位置从左侧扫到右侧（background-position 位移），而不是移动元素。占位块本身要静止，只有光在动。',
    sample: (tokens) =>
      animation({
        type: 'skeleton-shimmer',
        trigger: 'continuous',
        keyframes: [
          { at: 'from', declarations: { 'background-position': '-140% 0px' } },
          { at: 'to', declarations: { 'background-position': '140% 0px' } },
        ],
        duration: use(tokens, 'duration.normal', '300ms'),
        easing: 'linear',
        reducedMotion: { 'background-position': '0px 0px' },
      }),
  },
];

/**
 * 注入提示词的配方清单。
 *
 * 按 kind 过滤：让动画任务读到按钮配方的工法是纯噪音，还会挤掉真正相关的上下文。
 * 上限只是防御性的——当前每个 kind 的配方数都够少，全量注入约几百 token。
 */
export function describeRecipesForPrompt(kind: DesignKind, limit = 12): string {
  const relevant = RECIPES.filter((recipe) => recipe.kind === kind).slice(0, limit);
  if (relevant.length === 0) return '';
  return relevant.map((recipe) => `- ${recipe.name}：${recipe.technique}`).join('\n');
}

/** 供"试试这些"芯片使用（不含不可序列化的 sample） */
export function listRecipes(): Array<
  Pick<DesignRecipe, 'id' | 'name' | 'blurb' | 'category' | 'kind'>
> {
  return RECIPES.map(({ id, name, blurb, category, kind }) => ({
    id,
    name,
    blurb,
    category,
    kind,
  }));
}

export function findRecipe(id: string): DesignRecipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}
