import { designGet } from '../api-client';

export interface PreviewFileDto {
  path: string;
  content: string;
  target?: string;
  type?: string;
  language?: string;
}

export interface PreviewManifestDto {
  schemaVersion: string;
  slug: string;
  name: string;
  kind: string;
  subtype?: string;
  description?: string;
  preview: { entry: string };
  files: Array<{ path: string; target?: string; type?: string; language?: string }>;
  states?: string[];
  parts?: Array<{ id: string; name: string; selector?: string }>;
  tokens?: string[];
  tailwindClasses?: string[];
}

export interface PreviewSampleDto {
  html: string;
  css: string;
  js: string;
  classes: string[];
  contentHash: string;
  cssBytes: number;
  jsBytes: number;
  manifest: PreviewManifestDto;
  files: PreviewFileDto[];
}

export function getPreviewSample() {
  return designGet<PreviewSampleDto>('/design/preview/sample');
}

export function previewSnapshotUrl(viewport: string, state: string) {
  return `/api/design-proxy/design/preview/sample/snapshot?viewport=${encodeURIComponent(
    viewport,
  )}&state=${encodeURIComponent(state)}`;
}
