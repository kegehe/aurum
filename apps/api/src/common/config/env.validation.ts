import * as Joi from 'joi';

/**
 * 环境变量校验 schema
 * 缺少必填或格式不合法时，应用启动会失败并给出明确错误
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  STORAGE_DRIVER: Joi.string().valid('local').default('local'),
  STORAGE_ROOT: Joi.string().default('./storage'),
  MAX_UPLOAD_SIZE_MB: Joi.number().integer().min(1).default(1024),
  MAX_UPLOAD_TOTAL_SIZE_MB: Joi.number().integer().min(1).default(5120),
  TEMP_FILE_TTL_SECONDS: Joi.number().integer().min(60).default(3600),
  WORKER_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(5000),
  WORKER_MAX_RETRY: Joi.number().integer().min(0).max(10).default(3),
  WORKER_CONCURRENCY: Joi.number().integer().min(1).max(10).default(2),
  INGESTION_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(3000),
  INGESTION_STALE_JOB_TIMEOUT_MS: Joi.number().integer().min(20000).default(60000),
  INGESTION_HEALTH_CHECK_INTERVAL_MS: Joi.number().integer().min(60000).default(21600000),
  INGESTION_HEALTH_CHECK_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(10),
  THUMBNAIL_MAX_WIDTH: Joi.number().integer().min(1).default(400),
  THUMBNAIL_MAX_HEIGHT: Joi.number().integer().min(1).default(400),
});
