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
  const client = {
    messages: {
      create: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
        prompts.push(messages[0].content);
        const text = responses[call] ?? responses[responses.length - 1];
        call += 1;
        return { content: [{ type: 'text', text }] };
      }),
    },
  };
  const service = new DesignAgentService({
    activeProvider: { model: 'test-model' },
    buildClient: () => client,
  } as never);
  return { service, prompts };
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
    const service = new DesignAgentService({ activeProvider: null } as never);

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
