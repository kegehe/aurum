/**
 * 应用配置：从环境变量读取并解析为结构化配置
 */
export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL,
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    root: process.env.STORAGE_ROOT || './storage',
  },
  upload: {
    maxFileSizeMB: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '1024', 10),
    maxTotalSizeMB: parseInt(process.env.MAX_UPLOAD_TOTAL_SIZE_MB || '5120', 10),
    tempTtlSeconds: parseInt(process.env.TEMP_FILE_TTL_SECONDS || '3600', 10),
  },
  worker: {
    pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000', 10),
    maxRetry: parseInt(process.env.WORKER_MAX_RETRY || '3', 10),
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10),
  },
  ingestion: {
    pollIntervalMs: parseInt(process.env.INGESTION_POLL_INTERVAL_MS || '3000', 10),
    staleJobTimeoutMs: parseInt(process.env.INGESTION_STALE_JOB_TIMEOUT_MS || '60000', 10),
    healthCheckIntervalMs: parseInt(
      process.env.INGESTION_HEALTH_CHECK_INTERVAL_MS || '21600000',
      10,
    ),
    healthCheckBatchSize: parseInt(process.env.INGESTION_HEALTH_CHECK_BATCH_SIZE || '10', 10),
    autoSyncCheckIntervalMs: parseInt(
      process.env.INGESTION_AUTO_SYNC_CHECK_INTERVAL_MS || '60000',
      10,
    ),
    autoSyncBatchSize: parseInt(process.env.INGESTION_AUTO_SYNC_BATCH_SIZE || '10', 10),
  },
  thumbnail: {
    maxWidth: parseInt(process.env.THUMBNAIL_MAX_WIDTH || '400', 10),
    maxHeight: parseInt(process.env.THUMBNAIL_MAX_HEIGHT || '400', 10),
  },
  download: {
    maxFileSizeMB: parseInt(process.env.MAX_DOWNLOAD_FILE_SIZE_MB || '100', 10),
  },
  ai: {
    // 环境变量回退配置：数据库未配置生效项时使用。
    // 数据库配置可在「设置 → AI 配置」中运行时管理，无需重启。
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.ANTHROPIC_BASE_URL || '',
    styleModel: process.env.AI_STYLE_MODEL || 'claude-sonnet-5',
    maxImageSizeMB: parseInt(process.env.MAX_STYLE_IMAGE_SIZE_MB || '20', 10),
  },
  github: {
    // GitHub REST API Token（可选）；未配置时匿名访问，速率限额更低
    token: process.env.GITHUB_TOKEN || '',
  },
});
