/**
 * ClaudeVisionClient 单元测试
 *
 * mock @anthropic-ai/sdk，不发起真实网络请求。
 * 覆盖：tool_use 解析、强制 tool_choice 502 → 降级 auto / 纯 JSON 文本、
 * 无视觉守卫、API 抛错 → BadRequestException、未配 key 禁用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { AiSettingsService } from '../ai-settings/ai-settings.service';
import type { AiUsageService } from '../ai-usage/ai-usage.service';

const { createMock, AnthropicMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class AnthropicMock {
    static APIError = APIError;
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  }
  return { createMock, AnthropicMock };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

import { AiCallError, ClaudeVisionClient } from './claude-vision.client';

/** 构造 client，apiKey 为空时表示未配置 */
function makeClient(apiKey = 'test-key'): ClaudeVisionClient {
  const aiSettingsMock = {
    available: !!apiKey,
    modelName: apiKey ? 'claude-test' : '',
    activeProvider: apiKey ? { provider: 'anthropic', apiKey, model: 'claude-test' } : null,
    buildClient: () => ({ messages: { create: createMock } }),
  } as unknown as AiSettingsService;
  const usageMock = { record: vi.fn() } as unknown as AiUsageService;
  return new ClaudeVisionClient(aiSettingsMock, usageMock);
}

const image = { base64: 'aGVsbG8=', mediaType: 'image/png' as const };

/** 一个可通过可读性守卫的完整档案（真实模型返回的最小形态） */
const readableProfile = {
  colorPalette: {
    primary: { hex: '#111111', role: '主色' },
    background: { hex: '#ffffff', role: '背景' },
    accent: { hex: '#333333', role: '强调色' },
  },
};

describe('ClaudeVisionClient', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('available 反映是否配置生效 key', () => {
    expect(makeClient('').available).toBe(false);
    expect(makeClient('x').available).toBe(true);
  });

  it('analyzeStyle 解析 tool_use 输入为 StyleProfile', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'output_style_profile', input: readableProfile }],
    });
    const client = makeClient();
    const profile = await client.analyzeStyle(image, ['#ffffff'], 'prompt');
    expect(profile.colorPalette.primary.hex).toBe('#111111');
    // 校验请求里带了图片、生效配置的模型，且首选强制 tool_choice
    const sent = createMock.mock.calls[0][0];
    expect(sent.model).toBe('claude-test');
    expect(sent.messages[0].content[0].type).toBe('image');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'output_style_profile' });
  });

  it('强制 tool_choice 502 时降级 auto 并解析 tool_use', async () => {
    createMock
      .mockRejectedValueOnce(new AnthropicMock.APIError('Upstream service returned an error', 502))
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', name: 'output_style_profile', input: readableProfile }],
      });
    const client = makeClient();
    const profile = await client.analyzeStyle(image, ['#ffffff'], 'prompt');
    expect(profile.colorPalette.primary.hex).toBe('#111111');
    // 第一次走强制 tool_choice，第二次走 auto
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
  });

  it('强制与 auto 均失败时降级为纯 JSON 文本并解析', async () => {
    createMock
      .mockRejectedValueOnce(new AnthropicMock.APIError('Upstream service returned an error', 502))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '我无法读取图片' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(readableProfile) + '\n```' }],
      });
    const client = makeClient();
    const profile = await client.analyzeStyle(image, ['#ffffff'], 'prompt');
    expect(profile.colorPalette.primary.hex).toBe('#111111');
    expect(createMock).toHaveBeenCalledTimes(3);
    // 纯 JSON 兜底请求不携带 tools / tool_choice
    const third = createMock.mock.calls[2][0];
    expect(third.tools).toBeUndefined();
    expect(third.tool_choice).toBeUndefined();
    expect(third.messages[0].content.at(-1).type).toBe('text');
  });

  it('只缺 accent 不算「读不到图」：属模型抽风，交给 normalizeProfile 回退', async () => {
    // primary/background 齐全 = 模型确实看到了图，只是漏了一个必填字段。
    // 若这里抛 capability，用户会被告知"请更换支持视觉的模型"并白等 15 分钟退避，
    // 而实际上归一化能把 accent 补成像素强调色、产出完全可用的档案。
    const partial = {
      colorPalette: {
        primary: { hex: '#111111', role: '主色' },
        background: { hex: '#ffffff', role: '背景' },
        scale: ['#111111', '#ffffff'],
      },
    };
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'output_style_profile', input: partial }],
    });
    const client = makeClient();
    const profile = await client.analyzeStyle(image, ['#ffffff'], 'prompt');
    expect(profile.colorPalette.primary.hex).toBe('#111111');
  });

  it('色板三个关键色全缺才算读不到图', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'output_style_profile',
          input: { colorPalette: { scale: ['#111111'], mood: '无' } },
        },
      ],
    });
    const client = makeClient();
    const error = await client.analyzeStyle(image, ['#ffffff'], 'prompt').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiCallError);
    expect((error as AiCallError).kind).toBe('capability');
  });

  it('模型读不到图片（colorPalette 为 null）时给出可操作提示', async () => {
    createMock
      .mockRejectedValueOnce(new AnthropicMock.APIError('Upstream service returned an error', 502))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'no image' }] })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              colorPalette: null,
              styleGuideText: '无法分析：未提供有效图片。',
            }),
          },
        ],
      });
    const client = makeClient();
    const error = await client.analyzeStyle(image, ['#ffffff'], 'prompt').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiCallError);
    expect((error as Error).message).toContain('模型未能读取图片内容');
    // 归为 capability（配置/能力问题）而非 output：否则会跟着吃 1 分钟退避，
    // 配错模型的用户每次分析都要白打两次完整视觉调用
    expect((error as AiCallError).kind).toBe('capability');
  });

  it('全部降级路径失败且模型输出不可解析时，提示可能不支持图片', async () => {
    createMock
      .mockRejectedValueOnce(new AnthropicMock.APIError('Upstream service returned an error', 502))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'I cannot see any image' }] })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'It looks like the context was truncated.' }],
      });
    const client = makeClient();
    await expect(client.analyzeStyle(image, ['#ffffff'], 'prompt')).rejects.toThrow(
      '可能不支持图片输入',
    );
  });

  it('API 抛错时转为 BadRequestException（带原因）', async () => {
    createMock.mockRejectedValue(new Error('Invalid API key'));
    const client = makeClient();
    await expect(client.analyzeStyle(image, ['#ffffff'], 'prompt')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('未配置 key 时抛出 ServiceUnavailableException', async () => {
    const client = makeClient('');
    await expect(client.analyzeStyle(image, ['#ffffff'], 'prompt')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('generateVariations 兼容缺 variations 字段', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'output_style_variations', input: {} }],
    });
    const client = makeClient();
    const variations = await client.generateVariations({} as never, 'prompt');
    expect(variations).toEqual([]);
  });

  it('generateVariations 纯文本兜底兼容顶层数组输出', async () => {
    const list = [
      { name: 'Hero', description: 'd', composition: 'c', html: '<html>a</html>' },
      { name: 'Split', description: 'd2', composition: 'c2', html: '<html>b</html>' },
    ];
    createMock
      .mockRejectedValueOnce(new AnthropicMock.APIError('Upstream service returned an error', 502))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'no structured output' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(list) }] });
    const client = makeClient();
    const variations = await client.generateVariations({} as never, 'prompt');
    expect(variations).toHaveLength(2);
    expect(variations[0].name).toBe('Hero');
    expect(variations[1].name).toBe('Split');
  });
});
