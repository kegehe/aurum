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
  // 本进程是否执行处理任务 / 是否运行摄入调度；拆独立 Worker 时按进程关闭其一
  EXECUTION_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  INGESTION_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  WORKER_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(5000),
  WORKER_MAX_RETRY: Joi.number().integer().min(0).max(10).default(3),
  WORKER_CONCURRENCY: Joi.number().integer().min(1).max(10).default(2),
  INGESTION_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(3000),
  INGESTION_STALE_JOB_TIMEOUT_MS: Joi.number().integer().min(20000).default(60000),
  INGESTION_HEALTH_CHECK_INTERVAL_MS: Joi.number().integer().min(60000).default(21600000),
  INGESTION_HEALTH_CHECK_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(10),
  INGESTION_AUTO_SYNC_CHECK_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),
  INGESTION_AUTO_SYNC_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(10),
  INGESTION_RETRY_SWEEP_INTERVAL_MS: Joi.number().integer().min(60000).default(60000),
  INGESTION_RETRY_SWEEP_BATCH_SIZE: Joi.number().integer().min(1).max(100).default(20),
  THUMBNAIL_MAX_WIDTH: Joi.number().integer().min(1).default(400),
  THUMBNAIL_MAX_HEIGHT: Joi.number().integer().min(1).default(400),
  // 外部同步单文件下载上限（MB）。防止拉取超大数据。
  MAX_DOWNLOAD_FILE_SIZE_MB: Joi.number().integer().min(1).max(10240).default(100),
  // 出站 HTTP 代理（本机经本地代理访问外网时配置，如 http://127.0.0.1:10808）。
  // 未配置时走直连（带 SSRF DNS-pinning）。
  HTTP_PROXY: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  HTTPS_PROXY: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  NO_PROXY: Joi.string().allow('').optional(),
  // 出站 DNS 解析模式：auto=配了代理时用 DoH（默认），doh=总是优先 DoH，system=只用系统 DNS。
  // DoH 用于避开本地 DNS 污染导致的 SSRF 误判/连接失败；不可用时自动回退系统 DNS。
  SAFE_URL_DNS_MODE: Joi.string().valid('auto', 'doh', 'system').default('auto'),
  SAFE_URL_DOH_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .default('https://cloudflare-dns.com/dns-query'),
  SAFE_URL_DOH_TIMEOUT_MS: Joi.number().integer().min(500).max(10000).default(3000),
  // AI 样式分析（可选：未配置 ANTHROPIC_API_KEY 时样式实验室功能禁用，
  // 也可在「设置 → AI 配置」页面运行时配置，无需改 .env）
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  AI_STYLE_MODEL: Joi.string().default('claude-sonnet-5'),
  MAX_STYLE_IMAGE_SIZE_MB: Joi.number().integer().min(1).max(100).default(20),
  DESIGN_READ_API_KEY: Joi.string().min(16).allow('').optional(),
  DESIGN_INTERNAL_API_KEY: Joi.string().min(16).allow('').optional(),
  // GitHub API Token（可选）：github 来源同步使用；未配置时匿名访问（限额 60 次/小时）
  GITHUB_TOKEN: Joi.string().allow('').optional(),
});
