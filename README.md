# 资源管理平台

面向个人、工作室或小团队的多类型资源管理平台。系统支持上传、管理、预览、搜索、批量操作、回收站、处理任务和统计看板，当前以本地 SQLite + 本地磁盘存储为开发运行方式。

## 当前状态

已实现的主要能力：

| 模块           | 能力                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| 后端 API       | NestJS API、全局配置校验、统一错误响应、请求日志                                    |
| 数据模型       | Prisma + SQLite，资源、文件、标签、分类、集合、处理任务等核心表                     |
| 存储           | 本地磁盘存储、hash 分片路径、路径穿越防护                                           |
| 上传           | 单文件/批量上传、MIME 识别、SHA-256 去重、上传限制                                  |
| 资源管理       | 列表、详情、元数据更新、下载、预览、缩略图入口、重新处理                            |
| 搜索筛选       | 关键词、类型、分类、标签 AND/OR、收藏、处理状态、时间/大小范围、排序                |
| 标签/分类/集合 | CRUD、树形分类、集合详情、资源加入/移除集合                                         |
| 批量操作       | 批量移动分类、收藏/取消收藏、软删除、标签添加/移除、加入集合、ZIP 下载              |
| 回收站         | 软删除、恢复、彻底删除、清空回收站                                                  |
| 处理任务       | 进程内轮询调度、任务列表、统计、失败重试、临时文件清理                              |
| 统计与一致性   | 概览统计、资源类型统计、存储文件一致性检查                                          |
| 前端           | Next.js 15 管理界面：上传、资源库、详情、分类、标签、集合、回收站、处理任务、仪表盘 |
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
| `pnpm db:seed`     | 写入默认分类和标签     |
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
| `THUMBNAIL_MAX_WIDTH`      | 缩略图最大宽度    | `400`                       |
| `THUMBNAIL_MAX_HEIGHT`     | 缩略图最大高度    | `400`                       |
| `NEXT_PUBLIC_API_URL`      | Web 调用 API 地址 | `http://localhost:3000/api` |

## API 概览

所有 API 路径都有 `/api` 前缀。

### 上传

| 方法   | 路径                | 说明                      |
| ------ | ------------------- | ------------------------- |
| `POST` | `/api/upload`       | 单文件上传，字段名 `file` |
| `POST` | `/api/upload/batch` | 批量上传，字段名 `files`  |

上传可附带 `title`、`description`、`categoryId`、`source`、`author`、`licenseNote`。

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
| `POST`   | `/api/resources/:id/tags/:tagId` | 添加标签       |
| `DELETE` | `/api/resources/:id/tags/:tagId` | 移除标签       |
| `DELETE` | `/api/resources/trash/empty`     | 清空回收站     |

资源列表支持 `page`、`pageSize`、`keyword`、`resourceType`、`resourceTypes`、`categoryId`、`categoryIds`、`tagId`、`tagIds`、`tagMode`、`source`、`author`、`isFavorite`、`processingStatus`、`includeDeleted`、`sortBy`、`sortOrder` 等查询参数。

### 批量资源操作

| 方法   | 路径                               | 说明              |
| ------ | ---------------------------------- | ----------------- |
| `POST` | `/api/resources/batch/download`    | 批量 ZIP 下载     |
| `POST` | `/api/resources/batch/category`    | 批量移动分类      |
| `POST` | `/api/resources/batch/favorite`    | 批量收藏/取消收藏 |
| `POST` | `/api/resources/batch/delete`      | 批量软删除        |
| `POST` | `/api/resources/batch/tags/add`    | 批量添加标签      |
| `POST` | `/api/resources/batch/tags/remove` | 批量移除标签      |

### 标签、分类、集合

| 模块     | 路径                             |
| -------- | -------------------------------- |
| 标签     | `/api/tags`                      |
| 分类     | `/api/categories`                |
| 集合     | `/api/collections`               |
| 集合资源 | `/api/collections/:id/resources` |

### 处理任务、统计、一致性

| 方法   | 路径                                | 说明           |
| ------ | ----------------------------------- | -------------- |
| `GET`  | `/api/processing/jobs`              | 处理任务列表   |
| `GET`  | `/api/processing/stats`             | 任务状态统计   |
| `POST` | `/api/processing/jobs/:jobId/retry` | 重试任务       |
| `GET`  | `/api/stats/overview`               | 统计概览       |
| `GET`  | `/api/stats/resource-types`         | 资源类型统计   |
| `GET`  | `/api/consistency/check`            | 存储一致性检查 |

## 项目结构

```text
resource_service/
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

## 已知限制

- 前端 E2E、真实 multipart 集成测试、真实媒体处理链路测试尚未自动化。
- Web lint 当前使用 `next lint`，Next.js 15 会提示该命令将在 Next 16 移除。
- Web lint/build 会提示未检测到 Next ESLint plugin；目前不阻断构建。
- Docker Compose、生产备份和独立 Worker 部署仍需要后续整理。
- PostgreSQL、Redis/BullMQ、S3/MinIO 属于后续演进方向，当前默认运行不依赖它们。

## 相关文档

- [实施任务](docs/implementation-tasks.md)
- [验收清单](docs/acceptance-checklist.md)
- [交付说明](docs/delivery-notes.md)
