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
});
