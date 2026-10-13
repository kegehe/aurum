/**
 * 后端本地枚举常量 —— 自动生成，请勿手动编辑。
 *
 * 来源：packages/shared-types/src/enums.ts
 * 重新生成：`pnpm sync:enums`；同步校验：`pnpm check:enums`（CI 会跑）。
 *
 * 为什么是生成而不是直接引用：开发阶段 SQLite 不支持 Prisma enum，这些字段在 DB 中
 * 存为 String，由应用层用本文件常量约束。API 走 tsc 构建，无法直接消费 shared-types
 * 的裸 TS 源码；给它加构建产物又会引入跨包构建顺序依赖。详见 scripts/sync-shared-enums.mjs。
 */

/** 资源类型 */
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

/** 资源进入系统的方式 */
export enum AcquisitionMode {
  local_upload = 'local_upload',
  link_only = 'link_only',
  metadata_only = 'metadata_only',
  archive_snapshot = 'archive_snapshot',
  mirror_file = 'mirror_file',
}

/** 外部来源连接器类型 */
export enum SourceType {
  link_metadata = 'link_metadata',
  github = 'github',
  rss = 'rss',
  civitai = 'civitai',
  custom = 'custom',
}

/** 外部资源地址用途 */
export enum LocatorType {
  page = 'page',
  download = 'download',
  api = 'api',
  mirror = 'mirror',
  preview = 'preview',
  favicon = 'favicon',
}

/** 外部资源导入任务类型 */
export enum IngestionJobType {
  import_url = 'import_url',
  sync_source = 'sync_source',
  download_file = 'download_file',
  check_locator = 'check_locator',
  capture_page = 'capture_page',
}

/** 外部资源导入任务状态 */
export enum IngestionJobStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
  canceled = 'canceled',
}

/** 文件角色 */
export enum FileRole {
  original = 'original',
  thumbnail = 'thumbnail',
  preview = 'preview',
  extracted_text = 'extracted_text',
  transcode = 'transcode',
  snapshot = 'snapshot',
  /** 设计运营台预览/像素差异产物。注意本枚举值即存储 role 字符串（连字符形式）。 */
  design_preview = 'design-preview',
  design_diff = 'design-diff',
}

/** 资源处理状态（资源级） */
export enum ProcessingStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
}

/** 任务状态（任务级） */
export enum JobStatus {
  pending = 'pending',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
  canceled = 'canceled',
}

/** 任务类型 */
export enum JobType {
  detect_metadata = 'detect_metadata',
  generate_thumbnail = 'generate_thumbnail',
  generate_video_cover = 'generate_video_cover',
  extract_text = 'extract_text',
  detect_duplicate = 'detect_duplicate',
  cleanup_files = 'cleanup_files',
  cleanup_temp = 'cleanup_temp',
}
