import { DESIGN_BASE_URL, designDelete, designGet, designPost } from '../api-client';

export interface AssetSummary {
  id: string;
  slug: string;
  name: string;
  kind: string;
  subtype: string | null;
  description: string | null;
  format: string;
  status: string;
  favorite: boolean;
  tags: string[];
  hasCover: boolean;
  coverStatus: 'pending' | 'running' | 'succeeded' | 'failed' | null;
  coverError: string | null;
  palette: string[];
  states: string[];
  tokens: string[];
  version: {
    id: string;
    versionNumber: number;
    publishedAt: string | null;
  } | null;
  updatedAt: string;
}

export interface AssetFile {
  path: string;
  target?: string | null;
  type: string;
  language: string;
  content: string;
}

export interface AssetDetail extends AssetSummary {
  whenToUse: string | null;
  manifest:
    | (Record<string, unknown> & {
        preview?: { entry?: string };
        states?: string[];
        tokens?: string[];
        ai?: Record<string, unknown>;
      })
    | null;
  content: Record<string, unknown> | null;
  files: AssetFile[];
  createdAt: string;
}

export interface AssetVersionSummary {
  id: string;
  versionNumber: number;
  format: string;
  summary: string | null;
  contentHash: string;
  publishedAt: string | null;
  createdAt: string;
  fileCount: number;
}

export interface TokenContrastCheck {
  name: string;
  foreground: string;
  background: string;
  foregroundValue: string;
  backgroundValue: string;
  verdict: {
    status: 'pass' | 'fail' | 'undeterminable';
    ratio?: number;
    threshold?: number;
    reason?: string;
  };
}

export interface TokenContrastReport {
  status: 'pass' | 'fail' | 'undeterminable';
  checks: TokenContrastCheck[];
}

export interface TokenDependent {
  documentId: string;
  slug: string;
  name: string;
  kind: string;
  format: string;
  versionId: string;
  versionNumber: number;
  pinnedVersionId: string;
  outdated: boolean;
}

export interface TokenDependentsResult {
  token: {
    id: string;
    slug: string;
    name: string;
    versionId: string;
    versionNumber: number;
  };
  dependents: TokenDependent[];
}

export interface TokenRebuildResult {
  updated: number;
  skipped: number;
  results: Array<{
    documentId: string;
    slug: string;
    status: 'updated' | 'skipped';
    versionNumber?: number;
    error?: string;
  }>;
}

export interface TokenPatchResult {
  summary: string;
  rationale: string;
  content: Record<string, unknown>;
  contrast: TokenContrastReport;
}

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  candidateId: string | null;
  status: string;
  createdAt: string;
}

export interface StudioCandidate {
  id: string;
  label: string;
  rationale: string | null;
  status: string;
  changedPaths: string[];
  diff: Array<{ path: string; before: string; after: string }>;
  createdAt: string;
}

export interface StudioDraft {
  id: string;
  status: string;
  baseVersionId: string;
  revision: number;
  files: AssetFile[];
}

export interface StudioSession {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  asset: AssetDetail;
  draft: StudioDraft;
  messages: StudioMessage[];
  candidates: StudioCandidate[];
}

export interface StudioSendResult {
  session: StudioSession;
  candidate: StudioCandidate;
  changedPaths: string[];
}

export interface StudioApplyResult {
  session: StudioSession;
  preview: AssetPreview;
}

export interface StudioSaveResult {
  session: StudioSession;
  asset: AssetDetail;
}

export interface StudioUndoResult {
  session: StudioSession;
  preview: AssetPreview;
}

export interface StudioSessionSummary {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  draft: { id: string; status: string; revision: number } | null;
}

export interface StudioSnapshotSummary {
  id: string;
  revision: number;
  fileCount: number;
  createdAt: string;
}

export interface AssetVersionDiff {
  from: { id: string; versionNumber: number; contentHash: string };
  to: { id: string; versionNumber: number; contentHash: string };
  summary: { added: number; removed: number; changed: number };
  files: Array<{
    path: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    before?: string;
    after?: string;
  }>;
}

export interface AssetPreview {
  html: string;
  /** 组件或动效的片段。预览文档 html 还包着居中和背景，复制时用这段。 */
  fragment?: string;
  css: string;
  js: string;
  classes: string[];
  contentHash: string;
  cssBytes: number;
  jsBytes: number;
}

export interface AssetExport {
  format: string;
  files?: Array<{ path: string; content: string; type: string; language: string }>;
  dependencies?: string[];
  registryDependencies?: string[];
  install?: string;
  registry?: Record<string, unknown>;
  markdown?: string;
  css?: string;
  classes?: string[];
  html?: string;
  manifest?: Record<string, unknown>;
  content?: Record<string, unknown>;
  skipped?: string[];
  collisions?: string[];
}

export function listAssets(params: {
  kind?: string;
  subtype?: string;
  tag?: string;
  q?: string;
  status?: string;
  favorite?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}) {
  return designGet<{ items: AssetSummary[]; nextCursor: string | null }>('/design/assets', params);
}

export function getAsset(idOrSlug: string) {
  return designGet<AssetDetail>(`/design/assets/${encodeURIComponent(idOrSlug)}`);
}

export function assetCoverUrl(idOrSlug: string, versionId?: string) {
  const suffix = versionId ? `?v=${encodeURIComponent(versionId)}` : '';
  return `/api/design-proxy/design/assets/${encodeURIComponent(idOrSlug)}/cover${suffix}`;
}

export function getAssetPreview(idOrSlug: string) {
  return designGet<AssetPreview>(`/design/assets/${encodeURIComponent(idOrSlug)}/preview`);
}

export function getAssetExport(
  idOrSlug: string,
  format: 'react' | 'css' | 'registry' | 'ai' | 'json',
) {
  return designGet<AssetExport>(`/design/assets/${encodeURIComponent(idOrSlug)}/export`, {
    format,
  });
}

export function seedSampleAsset() {
  return designPost<AssetDetail>('/design/assets/seed-sample');
}

export function listAssetVersions(idOrSlug: string) {
  return designGet<{ items: AssetVersionSummary[] }>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/versions`,
  );
}

export function diffAssetVersions(
  idOrSlug: string,
  versionId: string,
  againstVersionId: string,
) {
  return designGet<AssetVersionDiff>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(versionId)}/diff`,
    { againstVersionId },
  );
}

export function listTokenDependents(idOrSlug: string) {
  return designGet<TokenDependentsResult>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/dependents`,
  );
}

export function rebuildTokenDependents(idOrSlug: string) {
  return designPost<TokenRebuildResult>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/dependents/rebuild`,
    {},
  );
}

export function generateTokenPatch(
  idOrSlug: string,
  content: Record<string, unknown>,
  request: string,
) {
  return designPost<TokenPatchResult>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/token-ai`,
    { content, request },
  );
}

export function checkTokenContrast(
  idOrSlug: string,
  content: Record<string, unknown>,
) {
  return designPost<TokenContrastReport>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/token-contrast`,
    { content },
  );
}

export function saveTokenVersion(
  idOrSlug: string,
  content: Record<string, unknown>,
  summary?: string,
) {
  return designPost<AssetDetail>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/token-versions`,
    { content, summary },
  );
}

export function saveAssetVersion(
  idOrSlug: string,
  input: {
    files: AssetFile[];
    summary?: string;
    publish?: boolean;
    /** 页面打开时看到的正式版本；服务端据此拒绝基于旧版本的并发保存 */
    baseVersionId?: string;
  },
) {
  return designPost<AssetDetail>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/versions`,
    input,
  );
}

export function createStudioSession(assetId: string) {
  return designPost<StudioSession>('/design/studio/sessions', { assetId });
}

export function listStudioSessions(assetId: string) {
  return designGet<{ items: StudioSessionSummary[] }>('/design/studio/sessions', {
    assetId,
  });
}

export function closeStudioSession(id: string) {
  return designPost<StudioSession>(
    `/design/studio/sessions/${encodeURIComponent(id)}/close`,
  );
}

export function listStudioSnapshots(id: string) {
  return designGet<{ items: StudioSnapshotSummary[] }>(
    `/design/studio/sessions/${encodeURIComponent(id)}/snapshots`,
  );
}

export function restoreStudioSnapshot(id: string, revision: number) {
  return designPost<StudioUndoResult>(
    `/design/studio/sessions/${encodeURIComponent(id)}/snapshots/${revision}/restore`,
  );
}

export function getStudioSession(id: string) {
  return designGet<StudioSession>(`/design/studio/sessions/${encodeURIComponent(id)}`);
}

export function getStudioSessionPreview(id: string) {
  return designGet<AssetPreview>(
    `/design/studio/sessions/${encodeURIComponent(id)}/preview`,
  );
}

export interface StudioStreamHandlers {
  onStatus?: (stage: string) => void;
  onDelta?: (text: string) => void;
  onCandidate?: (candidate: StudioCandidate, changedPaths: string[]) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

async function streamSseRequest(
  url: string,
  body: Record<string, unknown>,
  handlers: StudioStreamHandlers,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `AI 请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (block: string) => {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: unknown = null;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'status') {
      handlers.onStatus?.((data as { stage?: string }).stage ?? 'thinking');
    } else if (event === 'delta') {
      handlers.onDelta?.((data as { text?: string }).text ?? '');
    } else if (event === 'candidate') {
      const payload = data as {
        candidate?: StudioCandidate;
        changedPaths?: string[];
      };
      if (payload.candidate) {
        handlers.onCandidate?.(payload.candidate, payload.changedPaths ?? []);
      }
    } else if (event === 'done') {
      handlers.onDone?.();
    } else if (event === 'error') {
      handlers.onError?.((data as { message?: string }).message ?? 'AI 调用失败');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.trim()) dispatch(block);
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function streamStudioMessage(
  id: string,
  content: string,
  handlers: StudioStreamHandlers,
  signal?: AbortSignal,
) {
  return streamSseRequest(
    `${DESIGN_BASE_URL}/design/studio/sessions/${encodeURIComponent(id)}/messages/stream`,
    { content },
    handlers,
    signal,
  );
}

export function retryStudioMessage(
  id: string,
  handlers: StudioStreamHandlers,
  signal?: AbortSignal,
) {
  return streamSseRequest(
    `${DESIGN_BASE_URL}/design/studio/sessions/${encodeURIComponent(id)}/messages/retry/stream`,
    {},
    handlers,
    signal,
  );
}

export function applyStudioCandidate(id: string) {
  return designPost<StudioApplyResult>(
    `/design/studio/candidates/${encodeURIComponent(id)}/apply`,
  );
}

export function rejectStudioCandidate(id: string) {
  return designPost<StudioSession>(
    `/design/studio/candidates/${encodeURIComponent(id)}/reject`,
  );
}

export function undoStudioSession(id: string) {
  return designPost<StudioUndoResult>(
    `/design/studio/sessions/${encodeURIComponent(id)}/undo`,
  );
}

export function discardStudioSession(id: string) {
  return designPost<StudioUndoResult>(
    `/design/studio/sessions/${encodeURIComponent(id)}/discard`,
  );
}

export function saveStudioSession(id: string, summary?: string, files?: AssetFile[]) {
  return designPost<StudioSaveResult>(
    `/design/studio/sessions/${encodeURIComponent(id)}/save`,
    { summary, files },
  );
}

export function captureAssetSnapshot(idOrSlug: string) {
  return designPost<AssetDetail>(
    `/design/assets/${encodeURIComponent(idOrSlug)}/snapshot`,
  );
}

export function toggleAssetFavorite(id: string) {
  return designPost<AssetDetail>(`/design/assets/${encodeURIComponent(id)}/favorite`);
}

export function archiveAsset(id: string) {
  return designDelete<{ archived: boolean; id: string }>(
    `/design/assets/${encodeURIComponent(id)}`,
  );
}
