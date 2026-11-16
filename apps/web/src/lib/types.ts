/**
 * 前端类型定义
 *
 * 注意：sizeBytes 在后端是 BigInt，序列化为 string。
 * durationSeconds 是 Decimal，也序列化为 string。
 */

import type {
  AcquisitionMode,
  IngestionJobStatus,
  IngestionJobType,
  ResourceType,
  ProcessingStatus,
  JobStatus,
  JobType,
} from '@aurum/shared-types';

// ==================== 资源 ====================

export interface ResourceListItem {
  id: string;
  title: string;
  description: string | null;
  originalFilename: string;
  resourceType: ResourceType;
  mimeType: string;
  extension: string;
  sizeBytes: string;
  sha256: string | null;
  categoryId: string | null;
  source: string | null;
  author: string | null;
  acquisitionMode?: AcquisitionMode;
  sourceId?: string | null;
  externalCreatedAt?: string | null;
  externalUpdatedAt?: string | null;
  isFavorite: boolean;
  processingStatus: ProcessingStatus;
  duplicateOfId: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: string | null;
  /** 来源单独提供的远端缩略图（preview 定位器）；没有时前端可回退 downloadUrl */
  previewUrl?: string | null;
  /** 远端媒体真实地址（下载定位器）；视频卡片用它播放，避免把预览缩略图当成视频源 */
  downloadUrl?: string | null;
  /** 远程资源最近一次下载失败的原因；null 表示没有失败记录 */
  downloadError?: string | null;
  /** 该下载地址累计失败次数（成功后归零） */
  downloadAttempts?: number;
  /** 搜索用全文（仅详情/列表接口提供） */
  searchVector?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ResourceFile {
  id: string;
  resourceId: string;
  fileRole: string;
  variant: string;
  storagePath: string;
  mimeType: string;
  extension: string;
  sizeBytes: string;
  width: number | null;
  height: number | null;
  durationSeconds: string | null;
  createdAt: string;
}

export interface ResourceDetail extends ResourceListItem {
  files: ResourceFile[];
  locators?: ResourceLocator[];
  sourceRecord?: { id: string; name: string; slug: string } | null;
  provenance?: ResourceProvenance[];
  isDuplicate: boolean;
  duplicateOf: ResourceListItem | null;
}

export interface ResourceLocator {
  id: string;
  resourceId: string;
  locatorType: string;
  url: string;
  canonicalUrl: string | null;
  isPrimary: boolean;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  downloadAttempts?: number;
  nextDownloadAttemptAt?: string | null;
}

export interface ResourceProvenance {
  id: string;
  connectorType: string;
  connectorVersion: string;
  originalUrl: string;
  publisher: string | null;
  authorName: string | null;
  authorUrl: string | null;
  attributionText: string | null;
  capturedAt: string;
}

export interface UpdateResourceData {
  title?: string;
  description?: string | null;
  categoryId?: string | null;
  source?: string | null;
  author?: string | null;
}

/** 回收站统计：资源数 / 可回收文件数 / 可释放字节（按磁盘文件去重，大整数以字符串传输） */
export interface TrashStats {
  resourceCount: number;
  fileCount: number;
  totalSizeBytes: string;
}

/** 清空回收站的实时进度 */
export interface EmptyTrashProgress {
  totalResources: number;
  totalFiles: number;
  processedResources: number;
  processedFiles: number;
  deletedResources: number;
  deletedFiles: number;
  skippedResources: number;
}

/** 清空回收站的最终结果 */
export interface EmptyTrashResult {
  deletedResources: number;
  deletedFiles: number;
  skippedResources: number;
}

export interface SearchResourcesParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  source?: string;
  author?: string;
  resourceType?: ResourceType;
  resourceTypes?: ResourceType[];
  categoryId?: string;
  categoryIds?: string[];
  uncategorized?: boolean;
  acquisitionMode?: string;
  createdAtRange?: { start?: string; end?: string };
  updatedAtRange?: { start?: string; end?: string };
  sizeRange?: { min?: number; max?: number };
  isFavorite?: boolean;
  processingStatus?: ProcessingStatus;
  includeDeleted?: boolean;
  /** 仅返回回收站中的资源（deletedAt 非空） */
  deletedOnly?: boolean;
  sortBy?: 'createdAt' | 'updatedAt' | 'sizeBytes' | 'title';
  sortOrder?: 'asc' | 'desc';
}

// ==================== 上传 ====================

export interface UploadResult {
  resource: {
    id: string;
    title: string;
    resourceType: string;
    mimeType: string;
    sizeBytes: string;
    sha256: string | null;
    processingStatus: string;
    isDuplicate: boolean;
    duplicateOfId: string | null;
  };
}

export interface BatchUploadResult {
  results: Array<
    | { success: true; resource: UploadResult['resource'] }
    | { success: false; filename: string; error: string }
  >;
}

// ==================== 分类 ====================

export interface CategoryItem {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryTreeNode extends CategoryItem {
  resourceCount: number;
  children: CategoryTreeNode[];
}

export interface CreateCategoryData {
  name: string;
  parentId?: string;
  sortOrder?: number;
}

export interface UpdateCategoryData {
  name?: string;
  parentId?: string | null;
  sortOrder?: number;
}

// ==================== 处理任务 ====================

export interface ProcessingJobItem {
  id: string;
  resourceId: string;
  jobType: JobType;
  status: JobStatus;
  errorMessage: string | null;
  retryCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessingJobStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  canceled: number;
}

// ==================== 外部资源导入 ====================

export interface CreateLinkImportData {
  url: string;
  sourceId?: string;
  categoryId?: string;
  title?: string;
}

export interface IngestionJobItem {
  id: string;
  sourceId: string | null;
  resourceId: string | null;
  jobType: IngestionJobType;
  status: IngestionJobStatus;
  request: string;
  result: string | null;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  resource: { id: string; title: string } | null;
  source: { id: string; name: string } | null;
}

export interface ListIngestionJobsParams {
  status?: IngestionJobStatus;
  jobType?: IngestionJobType;
  sourceId?: string;
  resourceId?: string;
  page?: number;
  pageSize?: number;
}

export interface IngestionJobStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  canceled: number;
}

// ==================== 统计 ====================

export interface ResourceTypeStatsItem {
  type: ResourceType;
  count: number;
  percentage: number;
}

export interface DashboardOverview {
  resourceTotal: number;
  /** 已登记资源文件占用（按 storagePath 去重，包含回收站中的文件） */
  totalStorageBytes: string;
  /** 其中仅被回收站引用、清空后可释放的字节数 */
  trashStorageBytes: string;
  processingStats: ProcessingJobStats;
  resourceTypes: ResourceTypeStatsItem[];
  recentFailedJobs: Array<
    ProcessingJobItem & {
      resource: {
        id: string;
        title: string;
        originalFilename: string;
      };
    }
  >;
}

// ==================== AI 用量 ====================

export interface AiUsageTotals {
  requests: number;
  success: number;
  failed: number;
  canceled: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface AiUsageSeriesPoint {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AiUsageFeatureItem {
  feature: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface AiUsageModelItem {
  model: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsageLogItem {
  id: string;
  provider: string;
  providerId: string | null;
  providerName: string | null;
  model: string;
  feature: string;
  status: string;
  errorKind: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  createdAt: string;
}

export interface AiUsageOverview {
  range: { days: number; from: string; to: string };
  totals: AiUsageTotals;
  series: AiUsageSeriesPoint[];
  features: AiUsageFeatureItem[];
  models: AiUsageModelItem[];
  recent: AiUsageLogItem[];
}

// ==================== 来源 ====================

export interface SourceItem {
  id: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  sourceType: string;
  enabled: boolean;
  allowedModes: string;
  termsUrl: string | null;
  robotsUrl: string | null;
  rateLimitPerMinute: number;
  downloadIntervalMs: number;
  maxConcurrency: number;
  requiresReview: boolean;
  config: string | null;
  autoSyncIntervalHours: number | null;
  downloadDirectory: string | null;
  /** 同步下载的资源默认归入的资源库文件夹（Category.id）；null = 不归档 */
  downloadCategoryId: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SourceDetail = SourceItem;

export interface CreateSourceData {
  name: string;
  slug: string;
  baseUrl?: string;
  sourceType: string;
  enabled?: boolean;
  allowedModes?: string;
  termsUrl?: string;
  robotsUrl?: string;
  rateLimitPerMinute?: number;
  downloadIntervalMs?: number;
  maxConcurrency?: number;
  requiresReview?: boolean;
  config?: string;
  autoSyncIntervalHours?: number | null;
  downloadDirectory?: string;
  downloadCategoryId?: string;
}

export interface UpdateSourceData {
  name?: string;
  slug?: string;
  baseUrl?: string | null;
  sourceType?: string;
  enabled?: boolean;
  allowedModes?: string;
  termsUrl?: string | null;
  robotsUrl?: string | null;
  rateLimitPerMinute?: number;
  downloadIntervalMs?: number;
  maxConcurrency?: number;
  requiresReview?: boolean;
  config?: string | null;
  autoSyncIntervalHours?: number | null;
  downloadDirectory?: string | null;
  downloadCategoryId?: string | null;
}

// ==================== 样式实验室 ====================

export interface StyleColor {
  hex: string;
  role: string;
  approxName?: string;
}

export interface StyleColorPalette {
  primary: StyleColor;
  background: StyleColor;
  accent: StyleColor;
  scale: string[];
  mood: string;
}

export interface StyleTypeHierarchy {
  role: string;
  sizePx: number;
  weight: number;
  letterSpacing?: string;
}

export interface StyleTypography {
  familyTrait: string;
  suggestedFont?: string;
  weights: number[];
  hierarchy: StyleTypeHierarchy[];
  lineHeight: number;
}

export interface StyleSpacing {
  unit: number;
  scale: number[];
  density: 'compact' | 'comfortable' | 'loose';
}

export interface StyleLayout {
  composition: string;
  regions: string[];
  grid: { columns: number; gutterPx: number } | null;
  balance: string;
}

export interface StyleTextureMood {
  radius: string;
  shadow: string;
  gradient: string | null;
  density: string;
  keywords: string[];
}

export interface StyleProfile {
  colorPalette: StyleColorPalette;
  typography: StyleTypography;
  spacing: StyleSpacing;
  layout: StyleLayout;
  textureMood: StyleTextureMood;
  styleGuideText: string;
}

export interface StyleImagePrompt {
  midjourney: string;
  stableDiffusion: string;
  flux: string;
  referenceNote: string;
}

export interface StyleVariation {
  id: string;
  name: string;
  description: string;
  composition: string;
  html: string;
  imagePrompt: StyleImagePrompt;
}

export interface StyleExports {
  cssTokens: string;
  styleGuide: string;
}

export interface StyleAnalyzeResult {
  /** 样式档案来源 */
  source: 'ai' | 'local';
  /**
   * 布局变体来源。变体生成失败时保留 AI 档案、仅变体回退本地模板，
   * 此字段与 source 不同即表示「档案是 AI、变体是本地」。
   */
  variationsSource: 'ai' | 'local';
  image: { width: number; height: number; format: string };
  detectedColors: string[];
  profile: StyleProfile;
  variations: StyleVariation[];
  exports: StyleExports;
}

export interface StyleHealth {
  /** 功能可用性：样式实验室始终可用（AI 或本地），此字段恒为 true */
  available: boolean;
  /** 当前分析来源：ai / local */
  source: 'ai' | 'local';
  model: string;
  /** AI 已配置，但因近期调用失败被临时降级 —— 与「未配置 AI」是两回事 */
  degraded: boolean;
  /** 降级详情；未降级时为 null */
  degradation: {
    /**
     * 后端定义的失败分类（apps/api/src/modules/style/types.ts 的 `AiFailureKind`）。
     *
     * 这里刻意**不镜像**那份联合类型：前端不据此分支，只展示 reason 与 retryAfterMs，
     * 镜像一份只会随后端新增档位静默漂移 —— CI 的 `check:enums` 只覆盖
     * `common/constants/enums.ts`，管不到 style 模块的类型。
     */
    kind: string;
    /** 面向用户的可读原因 */
    reason: string;
    /** 距自动重试的剩余毫秒数 */
    retryAfterMs: number;
  } | null;
}

// ==================== AI 配置（设置 → AI 配置） ====================

export interface AiProviderItem {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  /** 掩码后的密钥（仅展示前后少量字符） */
  apiKey: string;
  hasApiKey: boolean;
  model: string;
  isActive: boolean;
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestStatus: 'ok' | 'error' | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderSummary {
  available: boolean;
  model: string;
  provider: string | null;
  name: string | null;
  /** db = 数据库生效配置；env = 回退到环境变量；null = 未配置 */
  source: 'db' | 'env' | null;
}

export interface AiTestResult {
  success: boolean;
  latencyMs?: number;
  model?: string;
  message?: string;
  error?: string;
}

export interface CreateAiProviderData {
  name: string;
  provider?: string;
  baseUrl?: string;
  apiKey: string;
  model?: string;
  enabled?: boolean;
  isActive?: boolean;
}

export interface UpdateAiProviderData {
  name?: string;
  provider?: string;
  baseUrl?: string | null;
  /** 留空 / 掩码值表示不修改现有密钥 */
  apiKey?: string;
  model?: string;
  enabled?: boolean;
  isActive?: boolean;
}

export interface TestAiProviderData {
  provider?: string;
  baseUrl?: string;
  apiKey: string;
  model?: string;
  name?: string;
}

// ==================== 存储一致性 ====================

/** 数据库与文件存储一致性检查报告（只读，不包含清理动作） */
export interface StorageConsistencyReport {
  checkedAt: string;
  databaseFileCount: number;
  storageFileCount: number;
  missingStorageFiles: string[];
  orphanStorageFiles: string[];
  expiredTempFiles: string[];
  summary: {
    missingStorageFiles: number;
    orphanStorageFiles: number;
    expiredTempFiles: number;
  };
}
