import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import {
  STORAGE_SERVICE,
  type IStorageService,
} from '../storage/interfaces/storage-service.interface';
import type { JsonRecord } from './design.types';

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 960 },
  tablet: { width: 1024, height: 900 },
  mobile: { width: 390, height: 844 },
};

@Injectable()
export class ControlledRendererService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: IStorageService) {}

  async render(content: JsonRecord, baseContent: JsonRecord, candidateId: string) {
    const browser = await chromium.launch({ headless: true });
    try {
      const candidateHtml = renderFixture(content);
      const baseHtml = renderFixture(baseContent);
      const outputs: Array<{
        viewport: string;
        snapshotKey: string;
        diffKey: string;
        artifactHash: string;
        changedPixels: number;
      }> = [];
      for (const [viewport, size] of Object.entries(VIEWPORTS)) {
        const candidatePng = await this.screenshot(browser, candidateHtml, size);
        const basePng = await this.screenshot(browser, baseHtml, size);
        const { diff, changedPixels } = await pixelDiff(basePng, candidatePng);
        const contentHash = sha256(candidatePng);
        const snapshotKey = this.storage.generateKey(
          'design-preview',
          contentHash,
          `${candidateId}-${viewport}`,
          'png',
        );
        const diffKey = this.storage.generateKey(
          'design-diff',
          sha256(diff),
          `${candidateId}-${viewport}`,
          'png',
        );
        await this.storage.put(snapshotKey, candidatePng);
        await this.storage.put(diffKey, diff);
        outputs.push({ viewport, snapshotKey, diffKey, artifactHash: contentHash, changedPixels });
      }
      return outputs;
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

function renderFixture(content: JsonRecord): string {
  const tokens = getFixtureContents(content).flatMap((fixture) => flattenTokens(fixture.tokens));
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
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}--fixture-bg:${bg};--fixture-text:${text};--fixture-accent:${accent};font-family:Arial,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--fixture-bg);color:var(--fixture-text)}.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}.nav{background:color-mix(in srgb,var(--fixture-accent) 12%,var(--fixture-bg));padding:24px;border-right:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent)}.main{padding:30px}.brand{font-weight:700;color:var(--fixture-accent);margin-bottom:28px}.nav-item{height:30px;margin:8px 0;border-radius:4px;background:color-mix(in srgb,var(--fixture-text) 8%,transparent)}h1{margin:0 0 8px;font-size:28px}.muted{opacity:.65;margin:0 0 26px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent);border-radius:6px;padding:18px;min-height:150px;background:color-mix(in srgb,var(--fixture-bg) 92%,white)}.bar{height:10px;border-radius:3px;background:color-mix(in srgb,var(--fixture-text) 14%,transparent);margin-top:12px}.button{display:inline-block;margin-top:16px;padding:9px 14px;border-radius:5px;background:var(--fixture-accent);color:white;font-size:13px}.spec-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.spec-row{border:1px solid color-mix(in srgb,var(--fixture-text) 18%,transparent);padding:12px;border-radius:6px}.spec-name{font-weight:700;color:var(--fixture-accent)}.spec-value{font-family:monospace;font-size:12px;line-height:1.45;overflow-wrap:anywhere;margin-top:8px}.region{min-height:86px;border:1px dashed color-mix(in srgb,var(--fixture-accent) 55%,transparent);padding:12px;border-radius:4px}@media(max-width:600px){.shell{grid-template-columns:1fr}.nav{display:none}.main{padding:20px}.cards,.spec-grid{grid-template-columns:1fr}}</style></head><body><div class="${layout}">${layout === 'shell' ? '<aside class="nav"><div class="brand">Aurum</div><div class="nav-item"></div><div class="nav-item"></div><div class="nav-item"></div></aside>' : ''}<main class="main">${body}</main></div></body></html>`;
}

/** Registered fixtures consume the complete safe JSON contract, never model HTML. */
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

function getFixtureContents(content: JsonRecord) {
  return [content, ...getFixtureDependencies(content).map((dependency) => dependency.content)];
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
