/**
 * 共享枚举定义
 *
 * 与 Prisma schema 中的枚举值保持一致，供前后端共用
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

/** 文件角色 */
export enum FileRole {
  original = 'original',
  thumbnail = 'thumbnail',
  preview = 'preview',
  extracted_text = 'extracted_text',
  transcode = 'transcode',
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
