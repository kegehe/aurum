# Aurum

Aurum 是面向个人、工作室或小团队的多类型资源管理平台。系统支持上传、管理、预览、搜索、批量操作、回收站、处理任务和统计看板，当前以本地 SQLite + 本地磁盘存储为开发运行方式。

## 当前状态

已实现的主要能力：

| 模块           | 能力                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| 后端 API       | NestJS API、全局配置校验、统一错误响应、请求日志                                    |
| 数据模型       | Prisma + SQLite，资源、文件、分类、处理任务等核心表                           |
| 存储           | 本地磁盘存储、hash 分片路径、路径穿越防护                                           |
| 上传           | 单文件/批量上传、MIME 识别、SHA-256 去重、上传限制                                  |
| 资源管理       | 列表、详情、元数据更新、下载、预览、缩略图入口、重新处理                            |
| 搜索筛选       | 关键词、类型、分类、收藏、处理状态、时间/大小范围、排序                         |
| 分类           | 树形分类                                                                           |
| 批量操作       | 批量移动分类、收藏/取消收藏、软删除、ZIP 下载                                    |
| 回收站         | 软删除、恢复、彻底删除、清空回收站                                                  |
| 处理任务       | 进程内轮询调度、任务列表、统计、失败重试、临时文件清理                              |
| 统计与一致性   | 概览统计、资源类型统计、存储文件一致性检查                                          |
| 外部资源接入   | 来源配置、链接导入、SSRF 防护、幂等任务、元数据提取、Civitai/GitHub/RSS 定时自动同步、页面 HTML 快照 |
| 样式实验室     | AI 视觉样式分析（配色/字体/排版/布局）、多种布局变体、生图提示词 / CSS Tokens 导出   |
| 前端           | Next.js 15 管理界面：上传、资源库、详情、分类、回收站、处理任务、仪表盘、样式实验室 |
| 测试验收       | API 单元测试、类型检查、lint、API/Web 生产构建                                      |

## 技术栈

| 层面     | 技术                                           |
| -------- | ---------------------------------------------- |
| 运行时   | Node.js >= 20                                  |
| 包管理   | pnpm workspace                                 |
| 后端     | NestJS 10, Prisma 5, SQLite                    |
| 前端     | Next.js 15, React 19, Tailwind CSS 4, Radix UI |
| 文件处理 | sharp, fluent-ffmpeg, pdf-parse, file-type     |
| 测试     | Vitest                                         |
| 存储     | 本地磁盘，后续可扩展 S3/MinIO                  |

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

API 使用 `apps/api/.env`：

```bash
cp .env.example apps/api/.env
```

Web 使用 `apps/web/.env.local`：

```bash
cp apps/web/.env.example apps/web/.env.local
```

默认配置下：

- API: `http://localhost:3000/api`
- Web: `http://localhost:3001`
- SQLite: `apps/api/prisma/dev.db`
- 本地文件: `storage/`

### 3. 初始化数据库

```bash
pnpm db:migrate
pnpm db:seed
```

### 4. 启动开发环境

同时启动 API 和 Web：

```bash
pnpm dev
```

也可以单独启动：

```bash
pnpm dev:api
pnpm dev:web
```

打开 `http://localhost:3001` 使用前端界面。健康检查地址为 `http://localhost:3000/api/health`。

## 常用命令

| 命令               | 说明                   |
| ------------------ | ---------------------- |
| `pnpm dev`         | 同时启动 API 与 Web    |
| `pnpm dev:api`     | 启动 API 开发服务      |
| `pnpm dev:web`     | 启动 Web 开发服务      |
| `pnpm test`        | 运行 API 单元测试      |
| `pnpm typecheck`   | 全 workspace 类型检查  |
| `pnpm lint`        | 全 workspace lint      |
| `pnpm build:api`   | 构建 API               |
| `pnpm build:web`   | 构建 Web               |
| `pnpm db:migrate`  | 执行 Prisma 迁移       |
| `pnpm db:seed`     | 写入默认分类     |
| `pnpm db:studio`   | 打开 Prisma Studio     |
| `pnpm db:generate` | 重新生成 Prisma Client |

## 验收命令

交付前建议运行：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:api
pnpm build:web
```

当前自动化测试覆盖见 [docs/acceptance-checklist.md](docs/acceptance-checklist.md)。

## 环境变量

| 变量                       | 说明              | 默认值                      |
| -------------------------- | ----------------- | --------------------------- |
| `NODE_ENV`                 | 运行环境          | `development`               |
| `PORT`                     | API 端口          | `3000`                      |
| `DATABASE_URL`             | Prisma 数据库连接 | `file:./prisma/dev.db`      |
| `STORAGE_DRIVER`           | 存储驱动          | `local`                     |
| `STORAGE_ROOT`             | 本地存储根目录    | `../../storage`             |
| `MAX_UPLOAD_SIZE_MB`       | 单文件上传上限    | `1024`                      |
| `MAX_UPLOAD_TOTAL_SIZE_MB` | 批量上传总上限    | `5120`                      |
| `TEMP_FILE_TTL_SECONDS`    | 临时文件保留时间  | `3600`                      |
| `WORKER_POLL_INTERVAL_MS`  | 任务轮询间隔      | `5000`                      |
| `WORKER_MAX_RETRY`         | 任务最大重试次数  | `3`                         |
| `WORKER_CONCURRENCY`       | 任务并发数        | `2`                         |
| `INGESTION_POLL_INTERVAL_MS` | 导入任务轮询间隔 | `3000`                    |
| `INGESTION_STALE_JOB_TIMEOUT_MS` | 导入任务超时 | `60000`                |
| `INGESTION_AUTO_SYNC_CHECK_INTERVAL_MS` | 来源定时自动同步检查间隔 | `60000`      |
| `INGESTION_AUTO_SYNC_BATCH_SIZE` | 每轮自动同步最多创建的任务数 | `10`            |
| `THUMBNAIL_MAX_WIDTH`      | 缩略图最大宽度    | `400`                       |
| `THUMBNAIL_MAX_HEIGHT`     | 缩略图最大高度    | `400`                       |
| `ANTHROPIC_API_KEY`        | AI Key 环境变量回退（页面「设置 → AI 配置」优先；数据库无生效配置时使用） | （空）   |
| `ANTHROPIC_BASE_URL`       | AI 自定义接口地址（可选，官方留空；SDK 自动追加 `/v1/messages`） | （空）   |
| `AI_STYLE_MODEL`           | 样式分析模型      | `claude-sonnet-5`           |
| `MAX_STYLE_IMAGE_SIZE_MB`  | 单张分析图片上限  | `20`                        |
| `GITHUB_TOKEN`             | GitHub API Token（可选，提高同步限额并支持私有仓库） | （空）               |
| `NEXT_PUBLIC_API_URL`      | Web 调用 API 地址 | `http://localhost:3000/api` |

## API 概览

所有 API 路径都有 `/api` 前缀。

### 上传

| 方法   | 路径                | 说明                      |
| ------ | ------------------- | ------------------------- |
| `POST` | `/api/upload`       | 单文件上传，字段名 `file` |
| `POST` | `/api/upload/batch` | 批量上传，字段名 `files`  |

上传可附带 `title`、`description`、`categoryId`、`source`、`author`。

### 资源

| 方法     | 路径                             | 说明           |
| -------- | -------------------------------- | -------------- |
| `GET`    | `/api/resources`                 | 资源列表       |
| `GET`    | `/api/resources/:id`             | 资源详情       |
| `PATCH`  | `/api/resources/:id`             | 更新元数据     |
| `GET`    | `/api/resources/:id/download`    | 下载原文件     |
| `GET`    | `/api/resources/:id/preview`     | 原文件内联预览 |
| `GET`    | `/api/resources/:id/thumbnail`   | 缩略图         |
| `DELETE` | `/api/resources/:id`             | 软删除         |
| `POST`   | `/api/resources/:id/restore`     | 恢复           |
| `DELETE` | `/api/resources/:id/permanent`   | 彻底删除       |
| `POST`   | `/api/resources/:id/reprocess`   | 重新处理       |
| `DELETE` | `/api/resources/trash/empty`     | 清空回收站     |

资源列表支持 `page`、`pageSize`、`keyword`、`resourceType`、`resourceTypes`、`categoryId`、`categoryIds`、`source`、`author`、`isFavorite`、`processingStatus`、`includeDeleted`、`deletedOnly`、`sortBy`、`sortOrder` 等查询参数。

### 批量资源操作

| 方法   | 路径                               | 说明              |
| ------ | ---------------------------------- | ----------------- |
| `POST` | `/api/resources/batch/download`    | 批量 ZIP 下载     |
| `POST` | `/api/resources/batch/category`    | 批量移动分类      |
| `POST` | `/api/resources/batch/favorite`    | 批量收藏/取消收藏 |
| `POST` | `/api/resources/batch/delete`      | 批量软删除        |

### 分类

| 模块     | 路径                             |
| -------- | -------------------------------- |
| 分类     | `/api/categories`                |

### 处理任务、统计、一致性

| 方法   | 路径                                | 说明           |
| ------ | ----------------------------------- | -------------- |
| `GET`  | `/api/processing/jobs`              | 处理任务列表   |
| `GET`  | `/api/processing/stats`             | 任务状态统计   |
| `POST` | `/api/processing/jobs/:jobId/retry` | 重试任务       |
| `GET`  | `/api/stats/overview`               | 统计概览       |
| `GET`  | `/api/stats/resource-types`         | 资源类型统计   |
| `GET`  | `/api/consistency/check`            | 存储一致性检查 |

### 来源

| 方法     | 路径                      | 说明                   |
| -------- | ------------------------- | ---------------------- |
| `GET`    | `/api/sources`            | 来源配置列表           |
| `GET`    | `/api/sources/:id`        | 来源详情               |
| `POST`   | `/api/sources`            | 创建来源配置           |
| `PATCH`  | `/api/sources/:id`        | 更新来源配置           |
| `DELETE` | `/api/sources/:id`        | 删除来源（资源保留，关联来源信息经外键置空/级联） |

### 外部资源导入

| 方法   | 路径                              | 说明               |
| ------ | --------------------------------- | ------------------ |
| `POST` | `/api/imports/link`               | 创建链接导入任务   |
| `GET`  | `/api/ingestion/jobs`             | 导入任务列表       |
| `GET`  | `/api/ingestion/jobs/:id`         | 导入任务详情       |
| `POST` | `/api/ingestion/jobs/:id/retry`   | 重试导入任务       |

### 样式实验室（AI）

| 方法   | 路径                  | 说明                                                       |
| ------ | --------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/style/health`   | 样式实验室可用性（恒可用）与当前来源 `ai` / `local`、模型名       |
| `POST` | `/api/style/analyze`  | 上传图片（multipart 字段 `image`）→ 样式档案 + 布局变体 + 导出包（AI 优先，失败/未配置自动降级本地，结果带 `source`） |

### AI 配置（设置 → AI 配置）

API Key / Base URL / 模型可在页面运行时管理，支持多个配置并切换生效项，无需改 `.env` 或重启 API。

| 方法     | 路径                          | 说明                                               |
| -------- | ----------------------------- | -------------------------------------------------- |
| `GET`    | `/api/ai-settings/summary`    | 当前生效配置摘要（含环境变量回退状态）             |
| `GET`    | `/api/ai-settings`            | 配置列表（密钥已掩码）                             |
| `GET`    | `/api/ai-settings/:id`        | 单个配置                                           |
| `POST`   | `/api/ai-settings`            | 创建配置（首个自动生效）                           |
| `PATCH`  | `/api/ai-settings/:id`        | 更新配置（`apiKey` 留空/掩码值表示不修改）         |
| `DELETE` | `/api/ai-settings/:id`        | 删除配置（生效项删除后自动提升其它启用配置）       |
| `POST`   | `/api/ai-settings/:id/activate` | 设为当前生效                                     |
| `POST`   | `/api/ai-settings/:id/test`   | 测试已保存配置并记录结果                           |
| `POST`   | `/api/ai-settings/test`       | 测试未保存的临时配置                               |

## 项目结构

```text
aurum/
├── apps/
│   ├── api/                 # NestJS API
│   │   ├── prisma/          # Prisma schema、迁移、seed
│   │   └── src/modules/     # 业务模块
│   ├── web/                 # Next.js 前端
│   └── worker/              # 独立 Worker workspace 预留
├── packages/
│   └── shared-types/        # 前后端共享类型/枚举
├── docs/                    # 方案、任务、验收和交付文档
├── scripts/                 # 开发辅助脚本
├── storage/                 # 本地存储目录
├── package.json
└── pnpm-workspace.yaml
```

## 开发说明

- 当前 Worker 使用 API 进程内的 `PollingJobScheduler` 轮询 `processing_jobs`，不是独立进程。
- 当前数据库为 SQLite。schema 中枚举以 `String` 存储，由应用层常量约束。
- `sizeBytes` 在数据库中是 `BigInt`，API 返回前会转为字符串。
- 本地存储 key 会经过路径穿越校验，禁止绝对路径、反斜杠、冒号、空字节和 `.`/`..` 段。
- 永久删除和清空回收站会先删除存储文件，再删除数据库记录；文件删除失败时记录保留，可重试。
- `pnpm lint` 会运行 API ESLint `--fix`，可能产生格式化改动。
- 样式实验室（`apps/api/src/modules/style`）是**精益版**：不落库、不走任务队列，`POST /style/analyze` 同步返回结果；颜色 HEX 由 sharp 确定性提取，大模型只做语义命名。**AI 未配置或调用失败时自动降级为本地确定性分析**（色板仍取自像素、布局用预置模板渲染，零费用），前端通过结果 `source: 'ai' | 'local'` 标识来源。
- AI Key 建议在「系统设置 → AI 配置」页面管理：支持多个配置、运行时切换生效项、连通性测试，立即生效。未配置任何数据库项时回退到环境变量 `ANTHROPIC_API_KEY`。

## 已知限制

- 前端 E2E、真实 multipart 集成测试、真实媒体处理链路测试尚未自动化。
- 样式实验室的 AI 模式依赖外部 API（单次分析会产生费用）；AI 未配置或失败时自动降级为本地确定性分析，因此功能始终可用。AI 管线已用 mock 覆盖单元测试，未做真实 Claude API 集成测试。
- Web lint 当前使用 `next lint`，Next.js 15 会提示该命令将在 Next 16 移除。
- Web lint/build 会提示未检测到 Next ESLint plugin；目前不阻断构建。
- Docker Compose、生产备份和独立 Worker 部署仍需要后续整理。
- PostgreSQL、Redis/BullMQ、S3/MinIO 属于后续演进方向，当前默认运行不依赖它们。

## 相关文档

- [实施任务](docs/implementation-tasks.md)
- [验收清单](docs/acceptance-checklist.md)
- [交付说明](docs/delivery-notes.md)
