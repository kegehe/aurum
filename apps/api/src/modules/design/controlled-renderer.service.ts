import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { FileRole } from '../../common/constants/enums';
import {
  STORAGE_SERVICE,
  type IStorageService,
} from '../storage/interfaces/storage-service.interface';
import {
  PSEUDO_STATES,
  collectWithFixtureDependencies,
  declarationsToCss,
  isValidTimingFunction,
  resolveDeclarations,
  resolveScalarText,
  stateClassName,
  type PseudoState,
  type TokenTable,
} from './design-css';
import type { DesignKind, JsonRecord } from './design.types';

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 960 },
  tablet: { width: 1024, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * 视口的规范顺序。
 *
 * 导出给列表接口用：预览行来自数据库关系，不指定顺序时返回顺序由 DB 决定，
 * 同一份数据在界面上可能排成 desktop/mobile/tablet，看上去像随机抖动。
 */
export const VIEWPORT_ORDER = Object.keys(VIEWPORTS);

/** 固定视口与固定夹具版本，预览才是可复现的（方案 §15.4） */
export const FIXTURE_VERSION = 'aurum.fixture.v2';

/**
 * 夹具字体栈。
 *
 * 注意：Arial 在不同平台是不同的字体，所以像素结果**跨机器不保证一致**。
 * 这个字符串会随渲染结果一起落库，作为可复现性的一部分留痕（方案 §15.4
 * 要求的字体清单，在没有加列的前提下先记进 JSON）。
 */
export const FIXTURE_FONT_STACK = 'Arial, Helvetica, sans-serif';

/** 动画胶片的采样帧数（含首尾） */
const ANIMATION_FRAME_COUNT = 6;
const ANIMATION_MIN_DURATION_MS = 1;
const ANIMATION_MAX_DURATION_MS = 10_000;

export interface RenderRequest {
  kind: DesignKind;
  /** 候选内容，钉住的依赖内容已注入 __aurumFixtureDependencies */
  content: JsonRecord;
  /** 基准内容，同上 */
  baseContent: JsonRecord;
}

export interface RenderOutput {
  viewport: string;
  snapshotKey: string;
  diffKey: string;
  artifactHash: string;
  changedPixels: number;
}

export interface RenderResult {
  browserVersion: string;
  fontStack: string;
  fixtureVersion: string;
  outputs: RenderOutput[];
}

@Injectable()
export class ControlledRendererService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: IStorageService) {}

  async render(request: RenderRequest, candidateId: string): Promise<RenderResult> {
    const browser = await chromium.launch({ headless: true });
    try {
      const candidateHtml = buildFixture(request.kind, request.content);
      const baseHtml = buildFixture(request.kind, request.baseContent);
      const outputs: RenderOutput[] = [];
      for (const [viewport, size] of Object.entries(VIEWPORTS)) {
        const candidatePng = await this.screenshot(browser, candidateHtml, size);
        const basePng = await this.screenshot(browser, baseHtml, size);
        const { diff, changedPixels } = await pixelDiff(basePng, candidatePng);
        const contentHash = sha256(candidatePng);
        const snapshotKey = this.storage.generateKey(
          FileRole.design_preview,
          contentHash,
          `${candidateId}-${viewport}`,
          'png',
        );
        const diffKey = this.storage.generateKey(
          FileRole.design_diff,
          sha256(diff),
          `${candidateId}-${viewport}`,
          'png',
        );
        await this.storage.put(snapshotKey, candidatePng);
        await this.storage.put(diffKey, diff);
        outputs.push({ viewport, snapshotKey, diffKey, artifactHash: contentHash, changedPixels });
      }
      return {
        browserVersion: browser.version(),
        fontStack: FIXTURE_FONT_STACK,
        fixtureVersion: FIXTURE_VERSION,
        outputs,
      };
    } finally {
      await browser.close();
    }
  }

  private async screenshot(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    html: string,
    viewport: { width: number; height: number },
  ) {
    const page = await browser.newPage({ viewport });
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(html, { waitUntil: 'load' });
      return await page.screenshot({ type: 'png', fullPage: false });
    } finally {
      await page.close();
    }
  }
}

/**
 * 依据资产类型选择夹具。
 *
 * 组件 v2 与动画渲真实元素与真实关键帧；其余（v1 组件、布局、样式包、Token）
 * 走既有的示意夹具，保持向后兼容。
 */
function buildFixture(kind: DesignKind, content: JsonRecord): string {
  const tokens = collectWithFixtureDependencies(content);
  if (kind === 'animation') return buildAnimationFixture(content, tokens);
  if (kind === 'component' && content.schemaVersion === 'aurum.component.v2') {
    return buildComponentFixture(content, tokens);
  }
  return buildLegacyFixture(content, tokens);
}

const BASE_CSS = `*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:#172033;font-family:${FIXTURE_FONT_STACK}}
.aurum-scope{padding:20px;display:flex;flex-direction:column;gap:20px}
.aurum-row{display:flex;flex-direction:column;gap:8px}
.aurum-row-label{font:600 12px/1.4 monospace;color:#5b6472;text-transform:uppercase}
.aurum-cells{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.aurum-cell{display:flex;flex-direction:column;gap:6px}
.aurum-cell-label{font:11px/1.4 monospace;color:#7a828e}
.aurum-stage{padding:16px;border:1px dashed rgba(0,0,0,.14);border-radius:8px;background:#fff;min-width:110px;display:flex;align-items:center;justify-content:center}
.aurum-anim-box{width:48px;height:48px;border-radius:8px;background:#1769aa}`;

function buildComponentFixture(content: JsonRecord, tokens: TokenTable): string {
  const componentType = String(content.componentType);
  const appliesTo = typeof content.appliesTo === 'string' ? content.appliesTo : 'element';
  const variants = isRecord(content.variants) ? content.variants : {};
  const css: string[] = [BASE_CSS];
  const rows: string[] = [];

  for (const [variantName, variant] of Object.entries(variants)) {
    if (!isRecord(variant)) continue;
    const selector = `.aurum-${componentType}-${variantName}`;
    const context = `${componentType}.${variantName}`;

    const base = resolveDeclarations(
      asRecord(variant.declarations),
      tokens,
      `${context}.declarations`,
    );
    if (Object.keys(base.css).length) css.push(declarationsToCss(selector, base.css));

    const stateNames: string[] = [];
    if (isRecord(variant.states)) {
      for (const [stateName, state] of Object.entries(variant.states)) {
        if (!(PSEUDO_STATES as readonly string[]).includes(stateName)) continue;
        const resolved = resolveDeclarations(
          asRecord(state),
          tokens,
          `${context}.states.${stateName}`,
        );
        if (!Object.keys(resolved.css).length) continue;
        // 状态用显式类而非 :hover —— 渲染不依赖交互，预览才是确定性的
        css.push(
          declarationsToCss(
            `${selector}.${stateClassName(stateName as PseudoState)}`,
            resolved.css,
          ),
        );
        stateNames.push(stateName);
      }
    }

    if (isRecord(variant.pseudo)) {
      for (const [element, declarations] of Object.entries(variant.pseudo)) {
        if (element !== 'before' && element !== 'after') continue;
        const resolved = resolveDeclarations(
          asRecord(declarations),
          tokens,
          `${context}.${element}`,
          {
            allowContent: true,
          },
        );
        if (Object.keys(resolved.css).length) {
          css.push(declarationsToCss(`${selector}::${element}`, resolved.css));
        }
      }
    }

    const cells = [null, ...stateNames]
      .map((state) => {
        const classes = [selector.slice(1), state ? stateClassName(state as PseudoState) : '']
          .filter(Boolean)
          .join(' ');
        return `<div class="aurum-cell"><div class="aurum-cell-label">${escapeHtml(state ?? 'default')}</div><div class="aurum-stage">${renderElement(appliesTo, classes)}</div></div>`;
      })
      .join('');
    rows.push(
      `<section class="aurum-row"><div class="aurum-row-label">${escapeHtml(variantName)}</div><div class="aurum-cells">${cells}</div></section>`,
    );
  }

  return wrapDocument(css.join('\n'), `<main class="aurum-scope">${rows.join('')}</main>`);
}

/**
 * 动画夹具：把同一动画的 N 个采样点**并排画在一页里**。
 *
 * 用负 `animation-delay` + `animation-play-state: paused`：浏览器在解析期就把
 * 动画定位到该时间点，零 JS、零时钟依赖。（先前的方案是逐帧截图再用 sharp
 * 拼图——那要求 WAAPI 定时采样，并且 6 帧横拼出的 9:1 图会被前端预览的
 * `aspect-[4/3]` + `object-cover` 裁掉，只剩中间一帧多。）
 */
function buildAnimationFixture(content: JsonRecord, tokens: TokenTable): string {
  const animationType = String(content.animationType);
  const name = `aurum-${animationType}`;
  const frames = Array.isArray(content.keyframes) ? content.keyframes : [];

  const keyframesCss = frames
    .map((frame) => {
      if (!isRecord(frame) || typeof frame.at !== 'string') return '';
      const resolved = resolveDeclarations(
        asRecord(frame.declarations),
        tokens,
        `keyframes.${frame.at}`,
      );
      const body = Object.entries(resolved.css)
        .map(([property, value]) => `    ${property}: ${value};`)
        .join('\n');
      return `  ${frame.at} {\n${body}\n  }`;
    })
    .filter(Boolean)
    .join('\n');

  const timing = isRecord(content.timing) ? content.timing : {};
  const duration = clampDuration(parseDurationMs(resolveScalarText(timing.duration, tokens)));
  const easing = asSafeTimingFunction(resolveScalarText(timing.easing, tokens));
  const iteration =
    timing.iterationCount === 'infinite' ? 'infinite' : String(timing.iterationCount ?? 1);

  const css = `${BASE_CSS}
@keyframes ${name} {
${keyframesCss}
}
.aurum-anim-box{animation-name:${name};animation-duration:${duration}ms;animation-timing-function:${easing};animation-fill-mode:both;animation-play-state:paused;animation-iteration-count:${iteration}}`;

  const cells = Array.from({ length: ANIMATION_FRAME_COUNT }, (_, index) => {
    const progress = index / (ANIMATION_FRAME_COUNT - 1);
    const delay = -Math.round(progress * duration);
    const label = `${Math.round(progress * 100)}%`;
    return `<div class="aurum-cell"><div class="aurum-cell-label">${label}</div><div class="aurum-stage"><div class="aurum-anim-box" style="animation-delay:${delay}ms"></div></div></div>`;
  }).join('');

  const trigger = typeof content.trigger === 'string' ? content.trigger : '';
  return wrapDocument(
    css,
    `<main class="aurum-scope"><section class="aurum-row"><div class="aurum-row-label">${escapeHtml(animationType)}${trigger ? ` · ${escapeHtml(trigger)}` : ''} · ${duration}ms</div><div class="aurum-cells">${cells}</div></section></main>`,
  );
}

function renderElement(appliesTo: string, classes: string): string {
  const attribute = ` class="${escapeHtml(classes)}"`;
  if (appliesTo === 'container') {
    return `<div${attribute}><strong>Card title</strong><p style="margin:4px 0 0;opacity:.75">Supporting line</p></div>`;
  }
  if (appliesTo === 'text') return `<p${attribute}>Sample paragraph text</p>`;
  return `<button type="button"${attribute}>Action</button>`;
}

function wrapDocument(css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

function parseDurationMs(value: string | null): number | null {
  if (!value) return null;
  const match = /^-?(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

function clampDuration(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 300;
  return Math.min(
    ANIMATION_MAX_DURATION_MS,
    Math.max(ANIMATION_MIN_DURATION_MS, Math.round(value)),
  );
}

/** 缓动值要进 CSS，非法就退回默认，避免把未校验的字符串注入样式表 */
function asSafeTimingFunction(value: string | null): string {
  if (value && isValidTimingFunction(value)) return value;
  if (value && /^cubic-bezier\([^()]*\)$/.test(value)) return value;
  return 'ease';
}

// ==================== 向后兼容的示意夹具 ====================

/** Registered fixtures consume the complete safe JSON contract, never model HTML. */
function buildLegacyFixture(content: JsonRecord, _tokens: TokenTable): string {
  const fixtureContents = [content, ...getFixtureDependencies(content).map((d) => d.content)];
  const tokens = fixtureContents.flatMap((fixture) => flattenTokens(fixture.tokens));
  const vars = tokens
    .map(([name, value]) => `--${escapeCss(name)}:${escapeCssValue(value)};`)
    .join('');
  const colors = tokens
    .filter(([name]) => /color|surface|background|text|border|brand|primary/i.test(name))
    .map(([, value]) => String(value));
  const bg = colors.find((value) => /^#|rgb|hsl/i.test(value)) ?? '#ffffff';
  const text = colors.slice(1).find((value) => /^#|rgb|hsl/i.test(value)) ?? '#172033';
  const accent = colors.slice(2).find((value) => /^#|rgb|hsl/i.test(value)) ?? '#1769aa';
  const layout = content.layoutType === 'app-shell' ? 'shell' : 'grid';
  const body = renderRegisteredFixture(content, layout);
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}--fixture-bg:${bg};--fixture-text:${text};--fixture-accent:${accent};font-family:${FIXTURE_FONT_STACK}}*{box-sizing:border-box}body{margin:0;background:var(--fixture-bg);color:var(--fixture-text)}.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}.nav{background:color-mix(in srgb,var(--fixture-accent) 12%,var(--fixture-bg));padding:24px;border-right:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent)}.main{padding:30px}.brand{font-weight:700;color:var(--fixture-accent);margin-bottom:28px}.nav-item{height:30px;margin:8px 0;border-radius:4px;background:color-mix(in srgb,var(--fixture-text) 8%,transparent)}h1{margin:0 0 8px;font-size:28px}.muted{opacity:.65;margin:0 0 26px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent);border-radius:6px;padding:18px;min-height:150px;background:color-mix(in srgb,var(--fixture-bg) 92%,white)}.bar{height:10px;border-radius:3px;background:color-mix(in srgb,var(--fixture-text) 14%,transparent);margin-top:12px}.button{display:inline-block;margin-top:16px;padding:9px 14px;border-radius:5px;background:var(--fixture-accent);color:white;font-size:13px}.spec-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.spec-row{border:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent);padding:12px;border-radius:6px}.spec-name{font-weight:700;color:var(--fixture-accent)}.spec-value{font-family:monospace;font-size:12px;line-height:1.45;overflow-wrap:anywhere;margin-top:8px}.region{min-height:86px;border:1px dashed color-mix(in srgb,var(--fixture-accent) 55%,transparent);padding:12px;border-radius:4px}@media(max-width:600px){.shell{grid-template-columns:1fr}.nav{display:none}.main{padding:20px}.cards,.spec-grid{grid-template-columns:1fr}}</style></head><body><div class="${layout}">${layout === 'shell' ? '<aside class="nav"><div class="brand">Aurum</div><div class="nav-item"></div><div class="nav-item"></div><div class="nav-item"></div></aside>' : ''}<main class="main">${body}</main></div></body></html>`;
}

function renderRegisteredFixture(content: JsonRecord, layout: 'shell' | 'grid'): string {
  if (typeof content.componentType === 'string') {
    const variants = isRecord(content.variants) ? Object.entries(content.variants) : [];
    return `<h1>${escapeHtml(content.componentType)} component</h1><p class="muted">Registered component fixture</p><section class="spec-grid">${variants.map(([name, value]) => `<article class="spec-row"><div class="spec-name">${escapeHtml(name)}</div><div class="spec-value">${escapeHtml(stableJson(value))}</div><span class="button">${escapeHtml(name)}</span></article>`).join('')}</section>`;
  }
  if (typeof content.layoutType === 'string') {
    const regions = Array.isArray(content.regions) ? content.regions.filter(isRecord) : [];
    return `<h1>${escapeHtml(content.layoutType)} layout</h1><p class="muted">Registered layout fixture</p><section class="${layout === 'shell' ? 'cards' : 'spec-grid'}">${regions.map((region) => `<article class="region"><div class="spec-name">${escapeHtml(String(region.id ?? 'region'))}</div><div class="spec-value">${escapeHtml(stableJson(region))}</div></article>`).join('')}</section>`;
  }
  if (Array.isArray(content.dependencies)) {
    const dependencies = getFixtureDependencies(content);
    return `<h1>Style pack</h1><p class="muted">Pinned dependency fixture</p><section class="spec-grid">${dependencies
      .map(
        (dependency) =>
          `<article class="spec-row"><div class="spec-name">${escapeHtml(dependency.documentId)} v${escapeHtml(dependency.versionId)}</div>${renderDependencyFixture(dependency.content)}</article>`,
      )
      .join('')}</section>`;
  }
  return '<h1>Token foundation</h1><p class="muted">Registered token fixture</p><section class="cards"><article class="card"><strong>Overview</strong><div class="bar"></div><div class="bar"></div><span class="button">Action</span></article><article class="card"><strong>Activity</strong><div class="bar"></div><div class="bar"></div></article><article class="card"><strong>Details</strong><div class="bar"></div><div class="bar"></div></article></section>';
}

function renderDependencyFixture(content: JsonRecord) {
  if (typeof content.componentType === 'string') {
    const variants = isRecord(content.variants) ? Object.entries(content.variants) : [];
    return `<div class="spec-value">${escapeHtml(content.componentType)}</div>${variants
      .map(([name]) => `<span class="button">${escapeHtml(name)}</span>`)
      .join('')}`;
  }
  if (typeof content.layoutType === 'string') {
    const regions = Array.isArray(content.regions) ? content.regions.filter(isRecord) : [];
    return `<div class="spec-value">${escapeHtml(content.layoutType)}</div>${regions
      .map((region) => `<div class="region">${escapeHtml(String(region.id ?? 'region'))}</div>`)
      .join('')}`;
  }
  const tokens = flattenTokens(content.tokens);
  return `<div class="spec-value">${escapeHtml(
    tokens.map(([name, value]) => `${name}: ${String(value)}`).join('\n'),
  )}</div><div class="bar"></div><span class="button">Token preview</span>`;
}

function getFixtureDependencies(content: JsonRecord): Array<{
  documentId: string;
  versionId: string;
  content: JsonRecord;
}> {
  const raw = content.__aurumFixtureDependencies;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.content)) return [];
    if (typeof item.documentId !== 'string' || typeof item.versionId !== 'string') return [];
    return [{ documentId: item.documentId, versionId: item.versionId, content: item.content }];
  });
}

function flattenTokens(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  if ('$value' in value && '$type' in value) return [[prefix, value.$value]];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenTokens(child, prefix ? `${prefix}-${key}` : key),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function escapeCss(value: unknown) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function escapeCssValue(value: unknown) {
  return String(value).replace(/[;{}<>]/g, '');
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sortValue(child)]),
      )
    : Array.isArray(value)
      ? value.map(sortValue)
      : value;
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function pixelDiff(before: Buffer, after: Buffer) {
  const [left, right] = await Promise.all([
    sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (left.info.width !== right.info.width || left.info.height !== right.info.height)
    throw new Error('Fixture dimensions differ');
  const diff = Buffer.alloc(left.data.length);
  let changedPixels = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    const delta =
      Math.abs(left.data[i] - right.data[i]) +
      Math.abs(left.data[i + 1] - right.data[i + 1]) +
      Math.abs(left.data[i + 2] - right.data[i + 2]);
    if (delta > 24) {
      changedPixels += 1;
      diff[i] = 255;
      diff[i + 1] = 66;
      diff[i + 2] = 66;
      diff[i + 3] = 210;
    } else {
      diff[i] = left.data[i];
      diff[i + 1] = left.data[i + 1];
      diff[i + 2] = left.data[i + 2];
      diff[i + 3] = 70;
    }
  }
  return {
    diff: await sharp(diff, {
      raw: { width: left.info.width, height: left.info.height, channels: 4 },
    })
      .png()
      .toBuffer(),
    changedPixels,
  };
}
