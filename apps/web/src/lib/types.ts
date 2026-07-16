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
} from '@resource-service/shared-types';

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
  licenseNote: string | null;
  acquisitionMode?: AcquisitionMode;
  sourceId?: string | null;
  licenseId?: string | null;
  licenseStatus?: string;
  externalCreatedAt?: string | null;
  externalUpdatedAt?: string | null;
  isFavorite: boolean;
  processingStatus: ProcessingStatus;
  duplicateOfId: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: string | null;
  searchVector: string | null;
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

export interface TagItem {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceDetail extends ResourceListItem {
  files: ResourceFile[];
  locators?: ResourceLocator[];
  sourceRecord?: { id: string; name: string; slug: string } | null;
  license?: { id: string; spdxId: string | null; name: string; url: string | null } | null;
  provenance?: ResourceProvenance[];
  tags: TagItem[];
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
  licenseText: string | null;
  licenseUrl: string | null;
  attributionText: string | null;
  capturedAt: string;
}

export interface UpdateResourceData {
  title?: string;
  description?: string;
  categoryId?: string;
  source?: string;
  author?: string;
  licenseNote?: string;
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
  tagId?: string;
  tagIds?: string[];
  tagMode?: 'and' | 'or';
  acquisitionMode?: string;
  createdAtRange?: { start?: string; end?: string };
  updatedAtRange?: { start?: string; end?: string };
  sizeRange?: { min?: number; max?: number };
  isFavorite?: boolean;
  processingStatus?: ProcessingStatus;
  includeDeleted?: boolean;
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

// ==================== 标签 ====================

export interface TagWithUsage extends TagItem {
  usageCount: number;
}

export interface CreateTagData {
  name: string;
  color?: string;
}

export interface UpdateTagData {
  name?: string;
  color?: string;
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

// ==================== 集合 ====================

export interface CollectionItem {
  id: string;
  name: string;
  description: string | null;
  coverResourceId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  resourceCount: number;
  coverResource: Pick<ResourceListItem, 'id' | 'title' | 'resourceType'> | null;
}

export interface CollectionDetail extends CollectionItem {
  resources: Array<ResourceListItem & { sortOrder: number }>;
}

export interface CreateCollectionData {
  name: string;
  description?: string;
  coverResourceId?: string;
}

export interface UpdateCollectionData {
  name?: string;
  description?: string;
  coverResourceId?: string | null;
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
  tagIds?: string[];
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
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  resource: { id: string; title: string } | null;
}

// ==================== 统计 ====================

export interface ResourceTypeStatsItem {
  type: ResourceType;
  count: number;
  percentage: number;
}

export interface DashboardOverview {
  resourceTotal: number;
  collectionTotal: number;
  totalStorageBytes: string;
  processingStats: ProcessingJobStats;
  resourceTypes: ResourceTypeStatsItem[];
  popularTags: Array<{
    id: string;
    name: string;
    color: string | null;
    usageCount: number;
  }>;
  recentFailedJobs: Array<ProcessingJobItem & {
    resource: {
      id: string;
      title: string;
      originalFilename: string;
    };
  }>;
}
