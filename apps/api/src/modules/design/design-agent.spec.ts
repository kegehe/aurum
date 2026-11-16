import { describe, expect, it, vi } from 'vitest';
import { DesignAgentService, type GeneratedDesignCandidate } from './design-agent.service';
import type { JsonRecord } from './design.types';

/**
 * AI 输出自修复。
 *
 * 这批用例守的是一个真实缺口：`parseResult` 不做 schema 校验，第一次真正的校验
 * 发生在 `createCandidate` → `validateDesignContent`，而它抛错曾经让**整批**
 * ai_generate 任务判死——外行说一句话就看到"设计任务失败"。
 */
function buildService(responses: string[]) {
  const prompts: string[] = [];
  let call = 0;
  const streamMock = vi.fn(({ messages }: { messages: Array<{ content: string }> }) => {
    prompts.push(messages[0].content);
    const text = responses[call] ?? responses[responses.length - 1];
    call += 1;
    return {
      on: vi.fn(),
      finalMessage: vi.fn(async () => ({
        model: 'test-model',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    };
  });
  const client = { messages: { stream: streamMock } };
  const service = new DesignAgentService(
    {
      activeProvider: { model: 'test-model' },
      buildClient: () => client,
    } as never,
    { record: vi.fn() } as never,
  );
  return { service, prompts, streamMock };
}

const BASE: JsonRecord = {
  schemaVersion: 'aurum.component.v2',
  componentType: 'glass-card',
  appliesTo: 'container',
  dependencies: [{ documentId: 'a', versionId: 'b' }],
  variants: { default: { declarations: { 'background-color': '#ffffff' } } },
};

function candidateBody(content: JsonRecord, label = 'A'): string {
  return JSON.stringify({
    candidates: [{ label, rationale: '理由', content }],
  });
}

describe('DesignAgentService.generateCandidates', () => {
  it('parses candidates out of a fenced JSON reply', async () => {
    const { service } = buildService(['```json\n' + candidateBody(BASE) + '\n```']);

    const candidates: GeneratedDesignCandidate[] = await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '玻璃拟态卡片',
      count: 3,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe('A');
    expect(candidates[0].content).toEqual(BASE);
  });

  it('uses streaming so long generations are not cut off as non-streaming requests', async () => {
    const { service, streamMock } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '玻璃拟态卡片',
      count: 1,
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(streamMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ model: 'test-model', max_tokens: 8_192, temperature: 0.35 }),
    );
  });

  it('explains how appliesTo and variants map to the preview skeleton', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '青柠胶囊按钮',
      count: 1,
    });

    expect(prompts[0]).toContain('COMPONENT DOCUMENT STRUCTURE');
    expect(prompts[0]).toContain('appliesTo must be "element"');
    expect(prompts[0]).toContain('variants.default.states');
    expect(prompts[0]).toContain('not the base placeholder custom-component');
  });

  it('spells out the three landmines the validator rejects', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '玻璃拟态卡片',
      count: 1,
    });

    // 这三条对应 assertSafeJson 的字符黑名单、isValidColorValue 与
    // isValidDimensionValue 的实际边界——不写进提示词，每次生成都要多花一轮修复。
    expect(prompts[0]).toContain('color-mix()');
    expect(prompts[0]).toContain('calc()');
    expect(prompts[0]).toContain('url(');
  });

  it('omits the reference section when no profile is supplied', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '玻璃拟态卡片',
      count: 1,
    });

    expect(prompts[0]).not.toContain('REFERENCE STYLE PROFILE');
  });

  it('puts the reference profile in the prompt but strips whole-page HTML variations', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'theme',
      baseContent: BASE,
      intent: '按这张图做',
      count: 1,
      reference: {
        colorPalette: { primary: '#1769aa' },
        variations: [{ name: 'hero', html: '<!doctype html><h1>SECRET</h1>' }],
      },
    });

    expect(prompts[0]).toContain('REFERENCE STYLE PROFILE');
    expect(prompts[0]).toContain('#1769aa');
    // 方案 §15.8：variations[].html 只能作构图参考，不能变成正式组件——
    // 塞进提示词只会诱导模型把它当模板抄。
    expect(prompts[0]).not.toContain('variations');
    expect(prompts[0]).not.toContain('SECRET');
  });

  it('injects the proven techniques for the document kind', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'component',
      baseContent: BASE,
      intent: '玻璃拟态卡片',
      count: 1,
    });

    // 配方不注入提示词，F 就是死代码——模型仍然只会给出半透明背景那种半成品
    expect(prompts[0]).toContain('PROVEN TECHNIQUES');
    expect(prompts[0]).toContain('渐变主按钮');
    expect(prompts[0]).not.toContain('淡入上移');
  });

  it('gives theme tasks the palettes instead of the component recipes', async () => {
    const { service, prompts } = buildService([candidateBody(BASE)]);

    await service.generateCandidates({
      kind: 'theme',
      baseContent: BASE,
      intent: '换成冷色调配色',
      count: 1,
    });

    expect(prompts[0]).toContain('靛蓝商务');
    expect(prompts[0]).not.toContain('渐变主按钮');
  });

  it('rejects a batch larger than the requested count', async () => {
    const { service } = buildService([
      JSON.stringify({
        candidates: [
          { label: 'A', rationale: 'r', content: BASE },
          { label: 'B', rationale: 'r', content: BASE },
        ],
      }),
    ]);

    await expect(
      service.generateCandidates({
        kind: 'component',
        baseContent: BASE,
        intent: '玻璃拟态卡片',
        count: 1,
      }),
    ).rejects.toThrow('没有返回符合数量限制');
  });

  it('fails loudly when AI is not configured', async () => {
    const service = new DesignAgentService(
      { activeProvider: null } as never,
      {
        record: vi.fn(),
      } as never,
    );

    await expect(
      service.generateCandidates({
        kind: 'component',
        baseContent: BASE,
        intent: '玻璃拟态卡片',
        count: 1,
      }),
    ).rejects.toThrow('AI 未配置');
  });
});

describe('DesignAgentService.generateAutoCandidates', () => {
  const BASES = {
    theme: { tokenSchemaVersion: 'aurum.tokens.v1', tokens: {} },
    component: BASE,
    animation: { schemaVersion: 'aurum.animation.v1' },
  };

  function autoBody(kind: string, name = '磨砂按钮'): string {
    return JSON.stringify({
      candidates: [{ kind, name, label: '方案 A', rationale: '理由', content: BASE }],
    });
  }

  it('carries the kind the model chose and the name it gave', async () => {
    const { service } = buildService([autoBody('component')]);

    const candidates = await service.generateAutoCandidates({
      intent: '悬停会发光的磨砂按钮',
      bases: BASES,
      count: 3,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('component');
    expect(candidates[0].name).toBe('磨砂按钮');
    expect(candidates[0].content).toEqual(BASE);
  });

  it('rejects a kind that was not offered in the bases', async () => {
    const { service } = buildService([autoBody('layout')]);

    await expect(
      service.generateAutoCandidates({
        intent: '整页布局',
        bases: BASES,
        count: 3,
      }),
    ).rejects.toThrow('不符合格式要求');
  });

  it('keeps the usable candidates when a sibling entry is malformed', async () => {
    const body = JSON.stringify({
      candidates: [
        { kind: 'component', label: '方案 A', rationale: '好', content: BASE },
        // 少写 content：常见的模型手滑，不该连累整批
        { kind: 'component', name: '坏的', label: '方案 B', rationale: '坏' },
        { kind: 'layout', label: '方案 C', rationale: '不支持', content: BASE },
        { kind: 'animation', label: '方案 D', rationale: '好', content: BASE },
      ],
    });
    const { service } = buildService([body]);

    const candidates = await service.generateAutoCandidates({
      intent: '一组动效和按钮',
      bases: BASES,
      count: 3,
    });

    expect(candidates.map((item) => item.label)).toEqual(['方案 A', '方案 D']);
  });

  it('cuts the batch down to the requested count instead of failing it', async () => {
    const body = JSON.stringify({
      candidates: ['A', 'B', 'C', 'D'].map((label) => ({
        kind: 'component',
        label,
        rationale: '好',
        content: BASE,
      })),
    });
    const { service } = buildService([body]);

    const candidates = await service.generateAutoCandidates({
      intent: '四个方案',
      bases: BASES,
      count: 3,
    });

    expect(candidates).toHaveLength(3);
  });

  it('tells the model the three landmines and the base schemas', async () => {
    const { service, prompts } = buildService([autoBody('component')]);

    await service.generateAutoCandidates({
      intent: '悬停会发光的磨砂按钮',
      bases: BASES,
      count: 1,
    });

    expect(prompts[0]).toContain('color-mix()');
    expect(prompts[0]).toContain('calc()');
    // 三份基底都要进提示词，否则模型没有可照抄的合法骨架
    expect(prompts[0]).toContain('### component');
    expect(prompts[0]).toContain('### animation');
  });

  it('teaches the component skeleton contract in auto mode', async () => {
    const { service, prompts } = buildService([autoBody('component')]);

    await service.generateAutoCandidates({
      intent: '青柠胶囊按钮',
      bases: BASES,
      count: 1,
    });

    expect(prompts[0]).toContain('COMPONENT DOCUMENT STRUCTURE');
    // 这是本次回归的核心：基底是 container，按钮必须被明确要求改成 element，
    // 否则预览骨架永远是 "Card content"。
    expect(prompts[0]).toContain('For a button-like component, appliesTo must be "element"');
    expect(prompts[0]).toContain('Never emit sibling variants named hover or active');
    expect(prompts[0]).toContain('never wrap it in another "declarations" key');
    expect(prompts[0]).toContain('"states": {');
    expect(prompts[0]).toContain('replace placeholder names and declarations');
  });
});

describe('DesignAgentService.repairCandidate', () => {
  it('feeds the validation error back and returns the repaired content', async () => {
    const fixed: JsonRecord = {
      ...BASE,
      variants: { default: { declarations: { 'background-color': '#1769aa' } } },
    };
    const { service, prompts } = buildService([JSON.stringify({ content: fixed })]);

    const repaired = await service.repairCandidate({
      kind: 'component',
      baseContent: BASE,
      content: {
        ...BASE,
        variants: { default: { declarations: { color: 'color-mix(in srgb, red, blue)' } } },
      },
      error: 'variants.default.declarations.color: 颜色值不合法',
    });

    expect(repaired).toEqual(fixed);
    expect(prompts[0]).toContain('颜色值不合法');
    expect(prompts[0]).toContain('color-mix');
    // 只修被拒的那一处：提示词必须把"其余保持逐字节一致"说清楚，否则模型会顺手
    // 重写别的声明，运营看到的就不是"同一个方案修好了"，而是另一个方案。
    expect(prompts[0]).toContain('byte-identical');
  });

  it('returns null when the model answers without a content object', async () => {
    const { service } = buildService([JSON.stringify({ content: 'not-an-object' })]);

    await expect(
      service.repairCandidate({
        kind: 'component',
        baseContent: BASE,
        content: BASE,
        error: '某个错误',
      }),
    ).resolves.toBeNull();
  });
});
