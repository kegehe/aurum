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
import type { ClaudeVisionClient } from './claude-vision.client';
import type { StyleProfile } from './types';

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
  layout: { composition: '居中', regions: ['main'], balance: '' },
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
    // 缓存生效：两次分析只发起了一次 AI 请求
    expect(analyzeStyle).toHaveBeenCalledTimes(1);
    // 降级缓存会如实反映到 availability（health 不再误报 ai）
    expect(service.availability.source).toBe('local');
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
    expect(ai.availability).toEqual({ available: true, source: 'ai', model: 'claude-test' });

    const local = new StyleService(
      { available: false, modelName: '' } as unknown as ClaudeVisionClient,
      createConfigMock() as never,
    );
    expect(local.availability).toEqual({ available: true, source: 'local', model: '' });
  });
});
