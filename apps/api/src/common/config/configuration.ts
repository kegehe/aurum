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
  },
  thumbnail: {
    maxWidth: parseInt(process.env.THUMBNAIL_MAX_WIDTH || '400', 10),
    maxHeight: parseInt(process.env.THUMBNAIL_MAX_HEIGHT || '400', 10),
  },
});
