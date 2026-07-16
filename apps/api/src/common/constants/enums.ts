/**
 * 后端本地枚举常量
 *
 * 值与 packages/shared-types/src/enums.ts 保持一致。
 * 开发阶段 SQLite 不支持 Prisma enum，这些字段在 DB 中存为 String，
 * 由应用层使用本文件常量约束。
 *
 * 切换 PostgreSQL 后，这些值会与 Prisma enum 对齐。
 */

export enum ResourceType {
  image = 'image',
  video = 'video',
  audio = 'audio',
  text = 'text',
  document = 'document',
  archive = 'archive',
  model3d = 'model3d',
  font = 'font',
  game_asset = 'game_asset',
  other = 'other',
}

export enum AcquisitionMode {
  local_upload = 'local_upload',
  link_only = 'link_only',
  metadata_only = 'metadata_only',
  archive_snapshot = 'archive_snapshot',
  mirror_file = 'mirror_file',
}

export enum SourceType {
  link_metadata = 'link_metadata',
  github = 'github',
  rss = 'rss',
  custom = 'custom',
}

export enum LocatorType {
  page = 'page',
  download = 'download',
  api = 'api',
  mirror = 'mirror',
  preview = 'preview',
  favicon = 'favicon',
}

export enum LicenseStatus {
  unknown = 'unknown',
  verified = 'verified',
  restricted = 'restricted',
  rejected = 'rejected',
}

export enum IngestionJobType {
  import_url = 'import_url',
  sync_source = 'sync_source',
  download_file = 'download_file',
  check_locator = 'check_locator',
  capture_page = 'capture_page',
}

export enum IngestionJobStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
  canceled = 'canceled',
}

export enum FileRole {
  original = 'original',
  thumbnail = 'thumbnail',
  preview = 'preview',
  extracted_text = 'extracted_text',
  transcode = 'transcode',
}

export enum ProcessingStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
}

export enum JobStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
  canceled = 'canceled',
}

export enum JobType {
  detect_metadata = 'detect_metadata',
  generate_thumbnail = 'generate_thumbnail',
  generate_video_cover = 'generate_video_cover',
  extract_text = 'extract_text',
  detect_duplicate = 'detect_duplicate',
  cleanup_files = 'cleanup_files',
  cleanup_temp = 'cleanup_temp',
}
