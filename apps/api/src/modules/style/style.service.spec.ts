/**
 * StyleService 单元测试
 *
 * - 使用真实 sharp 生成的小图验证确定性取色管线
 * - Claude 客户端用 mock（不发起真实 API 调用）
 * - 覆盖：AI 成功管线、AI 未配置/失败自动降级本地、归一化、导出包、非图片输入
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { StyleService } from './style.service';
import { AiCallError } from './claude-vision.client';
import * as colorExtractor from './extractors/color-extractor';
import type { ClaudeVisionClient } from './claude-vision.client';
import type { StyleProfile } from './types';

// 保留真实实现，只把 prepareImageForClaude 包成可临时改行为的 spy
// （取色仍需真实跑，否则拿不到像素色板）
vi.mock('./extractors/color-extractor', { spy: true });

function createRedPng(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

function createConfigMock() {
  return { get: vi.fn((key: string) => (key === 'ai.maxImageSizeMB' ? 20 : undefined)) };
}

/** 部分 profile，故意缺字段，验证归一化兜底 */
const partialProfile = {
  colorPalette: {
    primary: { hex: '#ff0000', role: '主色' },
    background: { hex: '#ffffff', role: '背景' },
    scale: ['#ff0000', '#ffffff'],
  },
  typography: { familyTrait: '无衬线', hierarchy: [], lineHeight: 1.6 },
  spacing: { unit: 8, scale: [4, 8, 16], density: 'comfortable' },
  layout: {
    composition: '居中',
    regions: ['main'],
    grid: { columns: 12, gutterPx: 24 },
    balance: '',
  },
  textureMood: { radius: '8px', shadow: 'none', keywords: ['极简'] },
  styleGuideText: '测试风格',
} as unknown as StyleProfile;

const fakeVariations = [
  {
    name: 'Hero 居中',
    description: '居中 hero',
    composition: '居中大标题',
    html: '<html><body>hero</body></html>',
  },
  {
    name: '左右分栏',
    description: '分栏',
    composition: '左窄右宽',
    html: '<html><body>split</body></html>',
  },
];

function createAvailableClientMock() {
  return {
    available: true,
    modelName: 'claude-test',
    providerKey: 'test|claude-test',
    analyzeStyle: vi.fn().mockResolvedValue(partialProfile),
    generateVariations: vi.fn().mockResolvedValue(fakeVariations),
  } as unknown as ClaudeVisionClient;
}

describe('StyleService', () => {
  it('AI 可用：取色 → 归一化 → 变体 → 导出包，source=ai', async () => {
    const service = new StyleService(createAvailableClientMock(), createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    // 来源为 AI
    expect(result.source).toBe('ai');

    // 确定性取色：纯红图至少提取到红色
    expect(result.detectedColors.length).toBeGreaterThan(0);
    expect(result.detectedColors[0].toLowerCase()).toBe('#ff0000');

    // 归一化：缺省字段被兜底
    expect(result.profile.colorPalette.accent.hex).toBeTruthy();
    expect(result.profile.typography.weights).toEqual([]);
    expect(result.profile.spacing.density).toBe('comfortable');
    // 合法栅格原样保留（归一化不能把正常值也吃掉）
    expect(result.profile.layout.grid).toEqual({ columns: 12, gutterPx: 24 });
    // 合法圆角/阴影同样原样保留
    expect(result.profile.textureMood.radius).toBe('8px');
    expect(result.profile.textureMood.shadow).toBe('none');

    // 变体：id 填充 + 每个变体挂生图提示词
    expect(result.variations).toHaveLength(2);
    expect(result.variations[0].id).toBe('v1');
    expect(result.variations[0].imagePrompt.midjourney).toContain('--sref');
    expect(result.variations[0].imagePrompt.referenceNote).toContain('原图');

    // 导出包
    expect(result.exports.cssTokens).toContain('--color-primary: #ff0000');
    expect(result.exports.styleGuide).toContain('测试风格');

    // 图片信息
    expect(result.image.width).toBe(4);
    expect(result.image.height).toBe(4);
  });

  it('未配置 API key 时自动使用本地分析（source=local）', async () => {
    const client = { available: false, modelName: '' } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    expect(result.source).toBe('local');
    // 色板来自像素，角色已分配
    expect(result.profile.colorPalette.primary.hex).toBeTruthy();
    expect(result.profile.colorPalette.background.hex).toBeTruthy();
    expect(result.profile.colorPalette.accent.hex).toBeTruthy();
    // 预置模板变体
    expect(result.variations.length).toBeGreaterThanOrEqual(3);
    // 导出包照常可用
    expect(result.exports.cssTokens).toContain('--color-primary:');
    expect(result.exports.styleGuide.length).toBeGreaterThan(0);
  });

  it('AI 可用但调用失败时自动降级为本地分析', async () => {
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockRejectedValue(new Error('Upstream service returned an error')),
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);
    expect(result.source).toBe('local');
    expect(client.analyzeStyle).toHaveBeenCalled();
  });

  it('AI 失败进入降级缓存后，二次调用直接走本地不再请求 AI', async () => {
    const analyzeStyle = vi.fn().mockRejectedValue(new Error('AI down'));
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const first = await service.analyze(file);
    const second = await service.analyze(file);

    expect(first.source).toBe('local');
    expect(second.source).toBe('local');
    // 首次分析：初次 + 一次重试；第二次分析命中降级缓存，不再发起任何 AI 请求
    expect(analyzeStyle).toHaveBeenCalledTimes(2);
    // 降级缓存会如实反映到 availability（health 不再误报 ai）
    expect(service.availability.source).toBe('local');
    expect(service.availability.degraded).toBe(true);
  });

  it('变体生成失败时不丢弃 AI 档案：source=ai、变体回退本地，且不污染 health', async () => {
    const generateVariations = vi.fn().mockResolvedValue([]);
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(partialProfile),
      generateVariations,
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    // 档案仍来自 AI，只是变体换成本地模板
    expect(result.source).toBe('ai');
    expect(result.variationsSource).toBe('local');
    // 用 styleGuideText 判定档案来源：红色测试图的本地档案 primary 也是 #ff0000，
    // 拿颜色断言分不出「保留的 AI 档案」和「本地兜底档案」
    expect(result.profile.styleGuideText).toBe('测试风格');
    expect(result.profile.colorPalette.primary.hex).toBe('#ff0000');
    expect(result.variations.length).toBeGreaterThanOrEqual(3);
    // 变体失败不应让 health 谎报「本地模式」——AI 档案这一半仍然是好的
    expect(service.availability.source).toBe('ai');
    expect(service.availability.degraded).toBe(false);
  });

  it('变体生成失败会重试一次（模型随机返回空结构）', async () => {
    const generateVariations = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(fakeVariations);
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(partialProfile),
      generateVariations,
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    expect(generateVariations).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('ai');
    expect(result.variationsSource).toBe('ai');
    expect(result.variations).toHaveLength(2);
  });

  it('样式档案失败也重试一次：一次抽风不再整体降级', async () => {
    const analyzeStyle = vi
      .fn()
      .mockRejectedValueOnce(new AiCallError('模型未能读取图片内容', 'output'))
      .mockResolvedValueOnce(partialProfile);
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    expect(analyzeStyle).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('ai');
    // 重试成功就不该留下降级状态
    expect(service.availability.degraded).toBe(false);
  });

  it('连接类失败不重试（重试只会再白等一个超时）', async () => {
    const analyzeStyle = vi
      .fn()
      .mockRejectedValue(new AiCallError('样式分析失败：fetch failed', 'connectivity'));
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const result = await service.analyze(file);

    expect(analyzeStyle).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('local');
  });

  it('AI 档案颜色非法时回退到像素派生色，不渲染成全黑', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    // 纯本地模式作为对照：拿到像素派生的权威颜色
    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // 模型给了 'white'、以及缺 hex/role 的对象 —— hexToRgb 对前两者都静默返回黑色
    const badColorProfile = {
      ...partialProfile,
      colorPalette: {
        primary: { hex: 'white', role: '主色' },
        background: {},
        accent: { hex: '#00ff00', role: '强调色' },
        scale: [],
        mood: '',
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(badColorProfile),
      // 变体生成失败 → 走「保留 AI 档案 + 本地模板变体」这条路径
      generateVariations: vi.fn().mockResolvedValue([]),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    expect(result.source).toBe('ai');
    expect(result.variationsSource).toBe('local');
    // 非法颜色回退到**像素派生色**（颜色必须确定性、不能靠模型猜），而非通用灰/黑色
    expect(result.profile.colorPalette.primary.hex).toBe(
      localOnly.profile.colorPalette.primary.hex,
    );
    expect(result.profile.colorPalette.background.hex).toBe(
      localOnly.profile.colorPalette.background.hex,
    );
    // 合法颜色原样保留
    expect(result.profile.colorPalette.accent.hex).toBe('#00ff00');
    expect(result.profile.colorPalette.accent.role).toBe('强调色');
    // 缺失的 role 兜底，避免导出成 "undefined"
    expect(result.profile.colorPalette.background.role).toBe('背景');
    // 模板变量取兜底后的值，不会出现全黑
    expect(result.variations[0].html).toContain(
      `--bg:${localOnly.profile.colorPalette.background.hex}`,
    );
    expect(result.variations[0].html).not.toContain('--bg:#000000');
  });

  it('AI 色板含非法值时整体回退像素色板，CSS 导出不会写进非法颜色', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);
    const localScale = localOnly.profile.colorPalette.scale;

    const badScaleProfile = {
      ...partialProfile,
      colorPalette: {
        ...partialProfile.colorPalette,
        // 一项非法 → 整块色板不可信，整体回退
        scale: ['#112233', '白色', '#445566'],
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(badScaleProfile),
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    expect(result.profile.colorPalette.scale).toEqual(localScale);
    // scale[0]/[1] 会被直接写成 --color-text / --color-muted，非法值会让浏览器丢掉整条声明
    expect(result.exports.cssTokens).not.toContain('白色');
    expect(result.exports.cssTokens).toContain(`--color-text: ${localScale[0]}`);
  });

  it('AI 给出全透明/半透明色时回退像素色板：不能让 alpha 被丢弃后当成"黑底浅字"', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // parseColor 对这几个都是真值（a=0），只看真值的守卫会放行；
    // 而下游 hexToRgb 丢掉 alpha 当成纯黑 → 模板按黑底算浅色文字 + 导出全透明背景
    const transparentProfile = {
      ...partialProfile,
      colorPalette: {
        primary: { hex: 'transparent', role: '主色' },
        background: { hex: '#00000000', role: '背景' },
        accent: { hex: 'rgba(0,0,0,0)', role: '强调色' },
        scale: ['#00000000', '#ffffff'],
        mood: '',
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(transparentProfile),
      // 变体走本地模板：只有这条路径会把颜色插进 `--bg`，正好用来验证渲染结果
      generateVariations: vi.fn().mockResolvedValue([]),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    const localPalette = localOnly.profile.colorPalette;
    expect(result.profile.colorPalette.primary.hex).toBe(localPalette.primary.hex);
    expect(result.profile.colorPalette.background.hex).toBe(localPalette.background.hex);
    expect(result.profile.colorPalette.accent.hex).toBe(localPalette.accent.hex);
    // scale 里含透明项 → 整体回退像素色板
    expect(result.profile.colorPalette.scale).toEqual(localPalette.scale);

    // 导出的 CSS 与变体模板都不能再出现透明色
    expect(result.exports.cssTokens).not.toContain('transparent');
    expect(result.exports.cssTokens).not.toContain('#00000000');
    expect(result.variations[0].html).not.toContain('--bg:#00000000');
    expect(result.variations[0].html).toContain(`--bg:${localPalette.background.hex}`);
  });

  it('模型给出错类型的字符串/数值字段时不崩：回退合法值，导出里不出现 NaN / [object Object]', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    // 本地档案作为回退值的对照（圆角/阴影回退到像素派生的本地值，不是硬编码常量）
    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // 全是 schema 违规。分两类后果：
    // - 进 CSS 的（familyTrait 数字时 `familyTrait.toLowerCase()` 抛 TypeError，
    //   而 buildCssTokens 没有 try/catch → 用户付了 token 只拿到 500）
    // - 只进导出文本的（mood/composition/regions/balance/gradient/keywords/styleGuideText
    //   会被直接插进模板字符串 → 导出成 "[object Object]"）
    const wrongTypesProfile = {
      ...partialProfile,
      colorPalette: { ...partialProfile.colorPalette, mood: 123 },
      typography: {
        ...partialProfile.typography,
        familyTrait: 123,
        lineHeight: '1.6',
        suggestedFont: {},
        weights: [400, '600'],
      },
      // density 在 tool schema 里限定为三档枚举，'sparse' 属越界值（前端拿它查 DENSITY_LABELS）
      spacing: { unit: '8', scale: ['x', 8], density: 'sparse' },
      layout: {
        ...partialProfile.layout,
        composition: {},
        regions: ['main', 42, ''],
        // typeof NaN === 'number' 为真：只判 typeof 会让它渲染成「NaN 栏栅格」
        grid: { columns: NaN, gutterPx: '24' },
        balance: [],
      },
      textureMood: {
        ...partialProfile.textureMood,
        radius: {},
        shadow: 0,
        gradient: { from: '#fff', to: '#000' },
        keywords: ['极简', {}, ''],
      },
      styleGuideText: { brief: '不是字符串' },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(wrongTypesProfile),
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    expect(result.profile.typography.familyTrait).toBe('无衬线');
    expect(result.profile.typography.lineHeight).toBe(1.5);
    expect(result.profile.typography.suggestedFont).toBeUndefined();
    expect(result.profile.typography.weights).toEqual([]);
    expect(result.profile.spacing.unit).toBe(8);
    expect(result.profile.spacing.scale).toEqual([4, 8, 16, 24, 48]);
    expect(result.profile.spacing.density).toBe('comfortable');
    expect(result.profile.textureMood.radius).toBe(localOnly.profile.textureMood.radius);
    expect(result.profile.textureMood.shadow).toBe(localOnly.profile.textureMood.shadow);
    // 只进导出文本的字段同样要归一化：非字符串会被模板字符串拼成 "[object Object]"
    expect(result.profile.colorPalette.mood).toBe('');
    expect(result.profile.layout.composition).toBe('');
    expect(result.profile.layout.regions).toEqual(['main']);
    expect(result.profile.layout.grid).toBeNull();
    expect(result.profile.layout.balance).toBe('');
    expect(result.profile.textureMood.gradient).toBeNull();
    expect(result.profile.textureMood.keywords).toEqual(['极简']);
    expect(result.profile.styleGuideText).toBe('');
    // 关键：导出包不能带出无效 CSS（`--space-NaN: NaNpx`、`--radius:[object Object]`）
    expect(result.exports.cssTokens).not.toContain('NaN');
    expect(result.exports.cssTokens).not.toContain('[object Object]');
    expect(result.exports.styleGuide).not.toContain('[object Object]');
    expect(result.exports.styleGuide).not.toContain('undefined');
    // 生图提示词由同一份档案拼出，同样不能出现占位符垃圾
    expect(result.variations[0].imagePrompt.midjourney).not.toContain('[object Object]');
  });

  it('模型把说明文字写进 CSS 值字段时回退本地档案：--radius/--shadow 不能是散文', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // 真实调用（2026-10 实测）返回的原样值：模型把字段当"描述"填了。
    // 它们会被原样写进 `--radius` / `--shadow`，浏览器整条丢弃
    // （CSS.supports('border-radius', …) 与 CSS.supports('box-shadow', …) 实测均为 false），
    // 导出的 token 看着成功、实际少了这两项。
    const proseProfile = {
      ...partialProfile,
      textureMood: {
        ...partialProfile.textureMood,
        radius: '矩形 0px 硬角，圆为完美正圆，无任何中间圆角规格',
        shadow: '无投影、无内外阴影，纯平涂矢量块面',
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(proseProfile),
      generateVariations: vi.fn().mockResolvedValue([]),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    const local = localOnly.profile.textureMood;
    expect(result.profile.textureMood.radius).toBe(local.radius);
    expect(result.profile.textureMood.shadow).toBe(local.shadow);
    // 导出的 CSS 与变体模板里都不能再出现散文
    expect(result.exports.cssTokens).toContain(`--radius: ${local.radius}`);
    expect(result.exports.cssTokens).toContain(`--shadow: ${local.shadow}`);
    expect(result.exports.cssTokens).not.toContain('矩形');
    expect(result.exports.cssTokens).not.toContain('无投影');
    expect(result.variations[0].html).toContain(`--radius:${local.radius}`);
    expect(result.variations[0].html).not.toContain('矩形');
  });

  it('合法但模型风格的圆角/阴影原样保留（归一化只挡非法值）', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const styledProfile = {
      ...partialProfile,
      textureMood: {
        ...partialProfile.textureMood,
        // `12px / 24px` 是 border-radius 的「水平 / 垂直」写法，CSS.supports 实测为真
        radius: '12px / 24px',
        shadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.12)',
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(styledProfile),
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    expect(result.profile.textureMood.radius).toBe('12px / 24px');
    expect(result.profile.textureMood.shadow).toBe('inset 0 1px 2px rgba(0, 0, 0, 0.12)');
  });

  it('说明文字里夹着长度值时也拦得住：阴影不能只看"有没有长度"', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // '轻微阴影，模糊 8px' 含一个合法长度 token，只判"有长度"就会放行；
    // 而 CSS.supports('box-shadow', …) 实测为 false —— 浏览器照样整条丢弃。
    const proseWithLength = {
      ...partialProfile,
      textureMood: { ...partialProfile.textureMood, shadow: '轻微阴影，模糊 8px' },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(proseWithLength),
      generateVariations: vi.fn().mockResolvedValue([]),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    expect(result.profile.textureMood.shadow).toBe(localOnly.profile.textureMood.shadow);
    expect(result.exports.cssTokens).not.toContain('模糊');
  });

  it('字距不是合法 CSS 长度时丢弃：--font-*-letter-spacing 不能是区间写法', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    // 真实调用实测返回过 '-0.03em ~ -0.02em'：塞进 `font` 简写会让整条声明失效，
    // 单独出 token 后它自己仍是非法值（CSS.supports('letter-spacing', …) 实测 false），
    // 所以必须在归一化阶段丢掉，而不是换个地方写。
    const rangeSpacing = {
      ...partialProfile,
      typography: {
        ...partialProfile.typography,
        hierarchy: [
          { role: 'display', sizePx: 64, weight: 800, letterSpacing: '-0.03em ~ -0.02em' },
          { role: 'body', sizePx: 16, weight: 400, letterSpacing: '-0.01em' },
        ],
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(rangeSpacing),
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const result = await service.analyze(file);

    const [display, body] = result.profile.typography.hierarchy;
    expect(display.letterSpacing).toBeUndefined();
    expect(body.letterSpacing).toBe('-0.01em');
    expect(result.exports.cssTokens).not.toContain('~');
    expect(result.exports.cssTokens).not.toContain('--font-display-letter-spacing');
    expect(result.exports.cssTokens).toContain('--font-body-letter-spacing: -0.01em;');
  });

  it('hex 不合格时 approxName 一并回退，不出现「像素色 + 模型给的名字」这种矛盾', async () => {
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    const localOnly = await new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    ).analyze(file);

    // 'white' 解析不出 → hex 退回像素色；但模型给的 approxName 是"白色"，
    // 只换 hex 的话 style-lab 会渲染成「#ff0000 · 白色」
    const mismatchedProfile = {
      ...partialProfile,
      colorPalette: {
        ...partialProfile.colorPalette,
        primary: { hex: 'white', role: '主色', approxName: '白色' },
      },
    } as unknown as StyleProfile;
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockResolvedValue(mismatchedProfile),
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);

    const primary = (await service.analyze(file)).profile.colorPalette.primary;

    expect(primary.hex).toBe(localOnly.profile.colorPalette.primary.hex);
    expect(primary.approxName).toBe(localOnly.profile.colorPalette.primary.approxName);
    expect(primary.approxName).not.toBe('白色');
  });

  it('模型读不到图（capability）用长退避（15 分钟），但仍保留一次重试', async () => {
    const analyzeStyle = vi
      .fn()
      .mockRejectedValue(new AiCallError('模型未能读取图片内容', 'capability'));
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    await service.analyze(file);

    expect(service.availability.degradation?.kind).toBe('capability');
    // 配错模型是确定性的：退避必须够长，否则每次分析都白打两次视觉调用
    expect(service.availability.degradation?.retryAfterMs).toBeGreaterThan(15 * 60_000 - 5000);
    expect(service.availability.degradation?.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
    // 但「网关本次未转发图片」是瞬时的，重试一次仍值得保留
    expect(analyzeStyle).toHaveBeenCalledTimes(2);
  });

  it('「模型输出无效」类失败用短退避（1 分钟），到期后自动重新尝试 AI', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const analyzeStyle = vi.fn().mockRejectedValue(new Error('模型未能读取图片内容'));
      const client = {
        available: true,
        modelName: 'claude-test',
        providerKey: 'test|claude-test',
        analyzeStyle,
        generateVariations: vi.fn(),
      } as unknown as ClaudeVisionClient;
      const service = new StyleService(client, createConfigMock() as never);
      const file = { buffer: await createRedPng() } as Express.Multer.File;

      await service.analyze(file);
      expect(service.availability.degraded).toBe(true);
      expect(service.availability.degradation?.kind).toBe('output');
      expect(service.availability.degradation?.retryAfterMs).toBe(60_000);

      // 退避期内：不再请求 AI（首次分析已重试过，故此时计数为 2）
      const afterFirst = analyzeStyle.mock.calls.length;
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      await service.analyze(file);
      expect(analyzeStyle).toHaveBeenCalledTimes(afterFirst);

      // 1 分钟后：自动恢复尝试 AI，不再永久卡在本地模式
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      expect(service.availability.source).toBe('ai');
      await service.analyze(file);
      expect(analyzeStyle.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('连接类失败用长退避（15 分钟）', async () => {
    const analyzeStyle = vi
      .fn()
      .mockRejectedValue(new AiCallError('样式分析失败：fetch failed', 'connectivity'));
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    await service.analyze(file);

    expect(service.availability.degradation?.kind).toBe('connectivity');
    // 记录与读取之间会流逝毫秒，留出余量
    expect(service.availability.degradation?.retryAfterMs).toBeGreaterThan(15 * 60_000 - 5000);
    expect(service.availability.degradation?.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('resetAiFailure 立即清除降级状态（前端「立即重试 AI」）', async () => {
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle: vi.fn().mockRejectedValue(new Error('AI down')),
      generateVariations: vi.fn(),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    await service.analyze(file);
    expect(service.availability.degraded).toBe(true);

    service.resetAiFailure();
    expect(service.availability.source).toBe('ai');
    expect(service.availability.degraded).toBe(false);
    expect(service.availability.degradation).toBeNull();
  });

  it('图片预处理失败不算 AI 故障：不写降级缓存，也不误报「AI 调用失败」', async () => {
    const analyzeStyle = vi.fn().mockResolvedValue(partialProfile);
    const client = {
      available: true,
      modelName: 'claude-test',
      providerKey: 'test|claude-test',
      analyzeStyle,
      generateVariations: vi.fn().mockResolvedValue(fakeVariations),
    } as unknown as ClaudeVisionClient;
    const service = new StyleService(client, createConfigMock() as never);
    const file = { buffer: await createRedPng() } as Express.Multer.File;

    // sharp 转码失败（图片本身的问题，与 AI 无关）
    vi.mocked(colorExtractor.prepareImageForClaude).mockRejectedValueOnce(
      new Error('unsupported image format'),
    );

    const result = await service.analyze(file);

    expect(result.source).toBe('local');
    // 根本没发起 AI 调用
    expect(analyzeStyle).not.toHaveBeenCalled();
    // 关键：AI 可用性不受影响，否则会把「AI 调用失败」的错误提示扣到一张
    // sharp 处理不了的图片头上，并连带停掉真正可用的 AI
    expect(service.availability.source).toBe('ai');
    expect(service.availability.degraded).toBe(false);
  });

  it('非图片输入抛出 BadRequestException', async () => {
    const service = new StyleService(createAvailableClientMock(), createConfigMock() as never);
    const file = { buffer: Buffer.from('this is not an image') } as Express.Multer.File;

    // 取色在所有模式之前执行，非图片输入直接报错
    await expect(service.analyze(file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('空文件抛出 BadRequestException', async () => {
    const service = new StyleService(createAvailableClientMock(), createConfigMock() as never);
    const file = { buffer: Buffer.alloc(0) } as Express.Multer.File;

    await expect(service.analyze(file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('可用性透出模型名与来源', () => {
    const ai = new StyleService(createAvailableClientMock(), createConfigMock() as never);
    expect(ai.availability).toEqual({
      available: true,
      source: 'ai',
      model: 'claude-test',
      degraded: false,
      degradation: null,
    });

    const local = new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    );
    // 未配置 AI：source=local 但 degraded=false，前端据此展示「去配置」而不是「临时降级」
    expect(local.availability).toEqual({
      available: true,
      source: 'local',
      model: '',
      degraded: false,
      degradation: null,
    });
  });
});
