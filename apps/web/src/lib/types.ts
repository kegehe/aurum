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
  /** Remote preview image/video URL for resources without a local thumbnail. */
  previewUrl?: string | null;
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
  totalStorageBytes: string;
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
  /** 分析来源：ai = 视觉 AI；local = 本地确定性分析（AI 未配置/失败时自动降级） */
  source: 'ai' | 'local';
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
