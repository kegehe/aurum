import {
  DESIGN_BASE_URL,
  designDelete as del,
  designGet as get,
  designPost as post,
} from '../api-client';

export type DesignKind =
  'foundation' | 'theme' | 'component' | 'layout' | 'style_pack' | 'animation';

export interface DesignVersion {
  id: string;
  versionNumber: number;
  summary?: string | null;
  content: string;
  publishedAt?: string | null;
}
export interface DesignDocument {
  id: string;
  slug: string;
  name: string;
  kind: DesignKind;
  status: string;
  currentPublishedVersionId?: string | null;
  currentPublishedVersion?: DesignVersion | null;
  versions?: DesignVersion[];
}
export interface DesignValidationRun {
  id: string;
  status: string;
  result?: string | null;
  errorMessage?: string | null;
  createdAt: string;
}
export interface Candidate {
  id: string;
  label: string;
  rationale?: string | null;
  patch: string;
  structuredDiff?: string | null;
  impactReport?: string | null;
  status: string;
  validationRuns?: DesignValidationRun[];
}
export interface CandidatePreview {
  viewport: 'desktop' | 'tablet' | 'mobile';
  changedPixels: number | null;
  snapshotUrl: string;
  diffUrl: string | null;
}
export interface DesignTask {
  id: string;
  taskType: string;
  status: string;
  candidateId?: string | null;
  errorMessage?: string | null;
  retryCount: number;
  createdAt: string;
  /** 任务产物（JSON 字符串）：对话生成的方案、预览图键、门禁结论都放这里 */
  result?: string | null;
}

export type DesignControlType = 'color' | 'scale' | 'choose' | 'range';

export interface DesignControlOption {
  label: string;
  value: string;
  /** 颜色选项的色值，用来画色块 */
  swatch?: string;
}

/** 服务端从内容反推出来的可视控件。只改已存在声明的值，不加属性、不改结构。 */
export interface DesignControl {
  key: string;
  label: string;
  type: DesignControlType;
  property: string;
  value: string;
  options?: DesignControlOption[];
  min?: number;
  max?: number;
  step?: number;
  numeric?: number;
}

export interface DesignGate {
  passed: boolean;
  errors: string[];
  contrasts: Array<{ source: string; ratio: number; threshold: number }>;
  undeterminable: string[];
}

export interface ComposePreviewResult {
  content: Record<string, unknown>;
  /** 实时预览用的派生 CSS（含 :root token 定义与 var() 引用） */
  css: string;
  /** 派生 HTML 骨架 */
  html: string;
  tokensUsed: string[];
  skippedTokens: string[];
  controls: DesignControl[];
  applied: string[];
  skipped: Array<{ key: string; reason: string }>;
  gate: DesignGate;
}

export interface ComposePublishResult {
  published: boolean;
  gate?: DesignGate;
  documentId?: string;
  versionId?: string | null;
  candidateId?: string;
  taskId?: string;
}

export interface DesignRecipeSummary {
  id: string;
  name: string;
  blurb: string;
  category: 'palette' | 'button' | 'card' | 'text' | 'motion';
  kind: DesignKind;
}

/** 效果配方清单。用于"试试这些"芯片。 */
export function listDesignRecipes() {
  return get<DesignRecipeSummary[]>('/design/recipes');
}

/** 从现成效果起手：不花 AI 调用，成品质量由服务端配方测试保证。 */
export function composeDesignRecipe(input: { recipeId: string; themeDocumentId?: string }) {
  return post<ComposePreviewResult & { kind: DesignKind }>('/design/compose/recipe', input);
}

/** 实时编译（含控件编辑）。不落库、不花 AI 调用、不开浏览器。 */
export function composeDesignPreview(input: {
  kind: DesignKind;
  content: Record<string, unknown>;
  themeDocumentId?: string;
  edits?: Record<string, string | number>;
}) {
  return post<ComposePreviewResult>('/design/compose/preview', input);
}

/** 让 AI 出方案。返回任务号，产物在任务的 result 里。 */
export function composeDesignGenerate(input: {
  kind: DesignKind;
  intent: string;
  themeDocumentId?: string;
  recipeId?: string;
  count?: number;
  reference?: Record<string, unknown>;
}) {
  return post<{ taskId: string }>('/design/compose/generate', input);
}

/** 一键保存并发布。门禁不通过时不写库，直接返回实测比值。 */
export function composeDesignPublish(input: {
  name: string;
  slug: string;
  kind: DesignKind;
  content: Record<string, unknown>;
  themeDocumentId?: string;
  summary?: string;
}) {
  return post<ComposePublishResult>('/design/compose/publish', input);
}

export function getDesignTask(taskId: string) {
  return get<DesignTask>(`/design/tasks/${taskId}`);
}

export function listDesignDocuments(kind?: string) {
  return get<DesignDocument[]>('/design/documents', kind ? { kind } : undefined);
}
export function getDesignDocument(id: string) {
  return get<DesignDocument>(`/design/documents/${id}`);
}
export function createDesignDocument(input: {
  name: string;
  slug: string;
  kind: DesignKind;
  content: Record<string, unknown>;
  summary?: string;
}) {
  return post<DesignDocument>('/design/documents', input);
}
export function createDraft(documentId: string) {
  return post<{ id: string }>(`/design/documents/${documentId}/drafts`);
}
export function createCandidate(
  draftId: string,
  input: { label: string; content: Record<string, unknown>; rationale?: string },
) {
  return post<Candidate>(`/design/drafts/${draftId}/candidates`, input);
}
export function queueAiCandidates(draftId: string, input: { intent: string; count?: number }) {
  return post<{ id: string }>(`/design/drafts/${draftId}/ai-candidates`, input);
}
export function renderAndValidateCandidate(candidateId: string) {
  return post(`/design/candidates/${candidateId}/render-validate`);
}
export function listCandidates(draftId: string) {
  return get<Candidate[]>(`/design/drafts/${draftId}/candidates`);
}
export function listCandidatePreviews(candidateId: string) {
  return get<CandidatePreview[]>(`/design/candidates/${candidateId}/previews`);
}
export function getCandidatePreviewUrl(
  candidateId: string,
  viewport: CandidatePreview['viewport'],
  kind: 'snapshot' | 'diff',
) {
  return `${DESIGN_BASE_URL}/design/candidates/${candidateId}/previews/${viewport}?kind=${kind}`;
}
export function selectCandidate(candidateId: string) {
  return post<Candidate>(`/design/candidates/${candidateId}/select`);
}
export interface DesignBundle {
  css?: string;
  html?: string;
  json?: unknown;
  tokensUsed?: string[];
  reducedMotion?: string;
  copyCss?: string;
  skippedTokens?: string[];
}
/** 内部导出入口：走内部守卫，浏览器不需要持有只读 key */
export function exportDesignDocument(
  id: string,
  format: 'json' | 'css' | 'tailwind' | 'markdown' | 'bundle',
) {
  return get<{ format: string; content: DesignBundle }>(`/design/documents/${id}/export`, {
    format,
  });
}
export function deleteCandidate(candidateId: string) {
  return del<{ deleted: boolean; removedArtifacts: number }>(`/design/candidates/${candidateId}`);
}
export function publishDraft(draftId: string) {
  return post<DesignVersion>(`/design/drafts/${draftId}/publish`);
}
export function restoreDesignVersion(documentId: string, versionId: string) {
  return post<DesignVersion>(`/design/documents/${documentId}/versions/${versionId}/restore`);
}
export function createReferenceDraft(
  documentId: string,
  profile: Record<string, unknown>,
  source = 'style-lab',
) {
  return post<{ draftId: string }>(`/design/documents/${documentId}/reference-draft`, {
    profile,
    source,
  });
}
export function createChangeSet(draftIds: string[]) {
  return post<{ id: string }>('/design/change-sets', { draftIds });
}
export function publishChangeSet(changeSetId: string) {
  return post(`/design/change-sets/${changeSetId}/publish`);
}
export function listReadyDrafts() {
  return get<
    Array<{
      id: string;
      document: { id: string; name: string; kind: DesignKind };
      candidates: Array<{ id: string; label: string }>;
    }>
  >('/design/drafts/ready');
}
export function listDesignTasks() {
  return get<DesignTask[]>('/design/tasks');
}
export function cancelDesignTask(taskId: string) {
  return post<DesignTask>(`/design/tasks/${taskId}/cancel`);
}
export function retryDesignTask(taskId: string) {
  return post<DesignTask>(`/design/tasks/${taskId}/retry`);
}
