import { BadRequestException } from '@nestjs/common';
import type { JsonRecord } from './design.types';

/**
 * 设计组件的媒体素材契约。
 *
 * 设计 content 里只存资源引用（resourceId + 可访问性/构图信息），不存 base64；
 * 预览、权威渲染与导出时再由 DesignMediaService 解析成 data URI。
 * 这样版本内容保持可审计、可比较，也不会因为一张图把每个版本撑大。
 */
export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_FITS = ['cover', 'contain'] as const;
export type MediaFit = (typeof MEDIA_FITS)[number];

export const MEDIA_POSITIONS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export type MediaPosition = (typeof MEDIA_POSITIONS)[number];

export interface MediaDescriptor {
  resourceId: string;
  kind: MediaKind;
  alt: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fit: MediaFit;
  position: MediaPosition;
}

export interface ResolvedMedia {
  dataUri: string;
  mimeType: string;
  kind: MediaKind;
  width?: number;
  height?: number;
}

const MEDIA_KEYS = new Set([
  'resourceId',
  'kind',
  'alt',
  'width',
  'height',
  'durationSeconds',
  'fit',
  'position',
]);

const ALLOWED_DATA_URI = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取并规范化组件里的 media；没有 media 返回 null。 */
export function getMediaDescriptor(content: JsonRecord): MediaDescriptor | null {
  if (content.media === undefined) return null;
  return validateMediaDescriptor(content.media);
}

export function validateMediaDescriptor(raw: unknown): MediaDescriptor {
  if (!isRecord(raw)) throw new BadRequestException('组件 media 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!MEDIA_KEYS.has(key)) {
      throw new BadRequestException(`组件 media 包含不支持字段: ${key}`);
    }
  }
  if (typeof raw.resourceId !== 'string' || !isUuid(raw.resourceId)) {
    throw new BadRequestException('组件 media.resourceId 必须是合法的资源 UUID');
  }
  if (raw.kind !== 'image' && raw.kind !== 'video') {
    throw new BadRequestException('组件 media.kind 必须是 image 或 video');
  }
  if (
    typeof raw.alt !== 'string' ||
    !raw.alt.trim() ||
    Array.from(raw.alt).length > 300
  ) {
    throw new BadRequestException('组件 media.alt 必须是 1–300 个字符的文本');
  }
  const descriptor: MediaDescriptor = {
    resourceId: raw.resourceId,
    kind: raw.kind,
    alt: raw.alt,
    fit: readEnum(raw.fit, MEDIA_FITS, 'cover', '组件 media.fit'),
    position: readEnum(raw.position, MEDIA_POSITIONS, 'center', '组件 media.position'),
  };
  if (raw.width !== undefined) {
    descriptor.width = readPositiveNumber(raw.width, 20_000, '组件 media.width');
  }
  if (raw.height !== undefined) {
    descriptor.height = readPositiveNumber(raw.height, 20_000, '组件 media.height');
  }
  if (raw.durationSeconds !== undefined) {
    descriptor.durationSeconds = readPositiveNumber(
      raw.durationSeconds,
      86_400,
      '组件 media.durationSeconds',
    );
  }
  return descriptor;
}

/**
 * 资源标题可能含 `<`、`url(` 等会触发设计内容安全扫描的字符。
 * media.alt 是服务端从资源信息生成的，写入 content 前必须先清洗。
 */
export function safeMediaAlt(value: string | null | undefined): string {
  const cleaned = (value ?? '')
    .replace(/[;{}<>]/g, ' ')
    .replace(/url\s*\(|@import|javascript\s*:|expression\s*\(/gi, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 按码点截断，避免把 emoji 的代理对切成一个非法字符。
  const limited = Array.from(cleaned).slice(0, 300).join('');
  return limited || '素材';
}

/** data URI 只接受浏览器可直接渲染的静态图片类型。 */
export function isSafeDataUri(value: string): boolean {
  if (!ALLOWED_DATA_URI.test(value)) return false;
  const comma = value.indexOf(',');
  return comma >= 0 && /^[A-Za-z0-9+/=]+$/.test(value.slice(comma + 1));
}

/**
 * 媒体组件的 HTML 骨架。
 *
 * 结构性样式用 inline style：figure 上的变体声明负责颜色/圆角/阴影/比例，
 * 但 position/overflow/object-fit 这类决定"图能不能铺满"的属性不能被声明覆盖。
 * 子元素不加 class，避免状态类名拼出无效子类名。
 */
export function buildMediaSkeleton(
  content: JsonRecord,
  className: string,
  media?: ResolvedMedia | null,
): string {
  const descriptor = getMediaDescriptor(content);
  if (!descriptor) throw new BadRequestException('组件内容不包含 media');

  const classes = escapeHtmlAttribute(className);
  const commonStyle =
    'position:relative;overflow:hidden;margin:0;width:100%;min-height:220px;display:flex;align-items:flex-end';
  const caption = `<figcaption style="position:relative;z-index:1;display:flex;flex-direction:column;gap:2px;width:100%;padding:16px;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.5)"><strong>Card title</strong><span>Supporting line</span></figcaption>`;

  if (!media) {
    return [
      `<figure class="${classes}" data-media-kind="${descriptor.kind}" style="${commonStyle}">`,
      `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.78);color:#fff;font-size:13px">素材不可用</span>`,
      caption,
      '</figure>',
    ].join('\n');
  }

  const src = escapeHtmlAttribute(media.dataUri);
  const alt = escapeHtmlAttribute(descriptor.alt);
  const imgStyle = `position:absolute;inset:0;width:100%;height:100%;object-fit:${descriptor.fit};object-position:${descriptor.position}`;
  const parts = [
    `<figure class="${classes}" data-media-kind="${descriptor.kind}" style="${commonStyle}">`,
    `<img src="${src}" alt="${alt}" style="${imgStyle}" />`,
    '<span aria-hidden="true" style="position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(180deg,transparent 45%,rgba(0,0,0,.65))"></span>',
  ];
  if (descriptor.kind === 'video') {
    parts.push(
      '<span aria-hidden="true" style="position:absolute;top:12px;right:12px;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:14px;line-height:1">▶</span>',
    );
    if (descriptor.durationSeconds !== undefined) {
      parts.push(
        `<span aria-hidden="true" style="position:absolute;top:16px;left:16px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;line-height:1.4">${formatDuration(descriptor.durationSeconds)}</span>`,
      );
    }
  }
  parts.push(caption, '</figure>');
  return parts.join('\n');
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new BadRequestException(`${label} 必须是 ${allowed.join(' / ')} 之一`);
}

function readPositiveNumber(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new BadRequestException(`${label} 必须大于 0 且不超过 ${max}`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
