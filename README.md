# Aurum

面向个人、工作室或小团队的多类型资源管理平台：上传、管理、预览、搜索、批量操作、回收站、处理任务、外部资源接入和统计看板。当前以本地 SQLite + 本地磁盘存储为开发运行方式。

## 能力

- **资源管理**：单文件/批量上传（SHA-256 去重、MIME 识别）、元数据编辑、下载与内联预览、缩略图、关键词/类型/分类/时间/大小的搜索筛选与排序、批量移动与收藏、软删除回收站、树形分类。
- **处理任务**：缩略图、转码、文本提取等异步任务。默认在 API 进程内轮询执行；设 `EXECUTION_ENABLED=false` 可把执行拆到独立 Worker 进程。
- **外部资源接入**：来源配置、链接导入、SSRF 防护、Civitai/GitHub/RSS 定时自动同步、页面 HTML 快照、链接健康检查与策略门禁。
- **AI**：样式实验室（视觉样式分析，未配置 Key 或调用失败时自动降级为本地确定性分析）、AI 设计运营台（设计资产版本化治理 + AI 候选 + 对比度门禁 + 受控渲染 + 只读导出，含**面向非专业用户的创建向导**：选配色 → 挑现成效果或描述一句 → 微调 → 一键发布）、页面内运行时 AI 配置管理（多套 Key 切换、连通性测试，无需重启）。
- **统计与一致性**：概览与资源类型统计、存储文件一致性检查。
- **前端**：Next.js 15 管理界面 — 仪表盘、资源库与详情、上传、添加链接、任务中心、来源管理、处理任务、回收站、样式实验室、设计运营台（创建向导 `/design-library` + 审核台 `/design-library/review`）、设置（AI 配置）。

## 技术栈

| 层面     | 技术                                           |
| -------- | ---------------------------------------------- |
| 运行时   | Node.js >= 20，pnpm workspace                  |
| 后端     | NestJS 10, Prisma 5, SQLite                    |
| 前端     | Next.js 15, React 19, Tailwind CSS 4, Radix UI |
| 文件处理 | sharp, fluent-ffmpeg, pdf-parse, file-type     |
| 测试     | Vitest                                         |
| 存储驱动 | 本地磁盘，后续可扩展 S3/MinIO                  |

## 快速开始

```bash
pnpm install
cp .env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm db:seed   # 写入默认分类
pnpm dev
```

- Web: `http://localhost:3001`
- API: `http://localhost:3000/api`（健康检查 `/api/health`）
- SQLite: `apps/api/prisma/dev.db`，本地文件: `storage/`

默认 `pnpm dev` 单进程即跑完全部工作。要把处理任务拆到独立进程：

```bash
EXECUTION_ENABLED=false pnpm dev:api   # 只入队，不认领任务
pnpm dev:worker                        # 只跑处理任务，摄入调度仍留在 API
```

两进程共用一个 SQLite 库，启动时自动开启 `journal_mode=WAL` 与 `busy_timeout`；Worker 必须以 `apps/api` 为工作目录启动（`@aurum/worker` 的 start 脚本已如此处理）。

## 常用命令

| 命令                                      | 说明                           |
| ----------------------------------------- | ------------------------------ |
| `pnpm dev`                                | 同时启动 API 与 Web            |
| `pnpm dev:api` / `dev:web` / `dev:worker` | 单独启动某个进程               |
| `pnpm test`                               | 运行 API 单元测试              |
| `pnpm typecheck` / `pnpm lint`            | 全 workspace 类型检查 / lint   |
| `pnpm build:api` / `pnpm build:web`       | 生产构建                       |
| `pnpm db:migrate` / `db:seed`             | Prisma 迁移 / 写入默认分类     |
| `pnpm db:studio` / `pnpm db:generate`     | Prisma Studio / 重新生成客户端 |

交付前验收：`pnpm test && pnpm typecheck && pnpm lint && pnpm build:api && pnpm build:web`（最近一次结果见 [docs/delivery-notes.md](docs/delivery-notes.md)）。

## 配置

全部变量及注释见 [.env.example](.env.example)（API 读 `apps/api/.env`，Web 读 `apps/web/.env.local`）。最常改动的：

| 变量                 | 说明                              | 默认                   |
| -------------------- | --------------------------------- | ---------------------- |
| `PORT`               | API 端口                          | `3000`                 |
| `DATABASE_URL`       | Prisma 数据库连接                 | `file:./prisma/dev.db` |
| `STORAGE_ROOT`       | 本地存储根目录（相对 `apps/api`） | `../../storage`        |
| `MAX_UPLOAD_SIZE_MB` | 单文件上传上限                    | `1024`                 |
| `EXECUTION_ENABLED`  | 本进程是否执行处理任务            | `true`                 |
| `ANTHROPIC_API_KEY`  | AI Key 环境变量回退，页面配置优先 | （空）                 |
| `GITHUB_TOKEN`       | GitHub 同步限额与私有仓库         | （空）                 |

本机经本地代理（Clash/V2Ray 等）访问外网时，必须配置 `HTTP_PROXY` / `HTTPS_PROXY`，否则后端 fetch 不走系统代理，外部同步会报 `fetch failed`。

## 项目结构

```text
aurum/
├── apps/
│   ├── api/               # NestJS API；src/modules 下按业务模块划分，路由前缀 /api
│   │   └── prisma/        # Prisma schema、迁移、seed
│   ├── web/               # Next.js 前端
│   └── worker/            # 独立处理任务 Worker（转发 @aurum/api 的 worker 入口）
├── packages/shared-types/ # 前后端共享类型与枚举
├── docs/                  # 方案、任务、验收与交付文档
├── scripts/               # 开发辅助脚本
└── storage/               # 本地存储目录
```

## 开发注意

- 数据库为 SQLite，schema 中枚举以 `String` 存储、由应用层常量约束；`sizeBytes` 是 `BigInt`，API 返回前转为字符串。
- 永久删除和清空回收站先删存储文件、再删数据库记录；文件删除失败时记录保留，可重试。
- 本地存储 key 经过路径穿越校验（禁止绝对路径、反斜杠、冒号、空字节和 `.`/`..` 段）。
- 样式实验室是**精益版**：不落库、不进任务队列，同步返回结果；颜色 HEX 由 sharp 确定性提取，大模型只做语义命名。
- `pnpm lint` 会运行 API ESLint `--fix`，可能产生格式化改动。
- API 开发启动复用 `dist/` 的增量编译缓存：`nest-cli.json` 关闭了 `deleteOutDir`，`tsconfig.build.json` 把 `tsBuildInfoFile` 放到 `node_modules/.cache/`。关闭 `deleteOutDir` 后重启走增量（约 4s）而不是每次全量（约 30s）。代价是产物里可能残留已删除源文件的 `.js`，需要干净产物时跑 `pnpm --filter @aurum/api clean:dist`（注意：这个命令会连增量缓存一起清掉，之后第一次构建必然是全量）。
- **全新 clone 后要先 `pnpm db:generate`，再 `pnpm build:api`，最后才能 `typecheck` / `build:worker`**：Prisma Client 的生成产物在 gitignore 里，缺了它 API 会报几百个 `Property 'xxx' does not exist on type 'PrismaService'`；而 `apps/worker` 校验和构建的是 `@aurum/api/dist/worker`，API 没构建过就会报 TS2307。CI 已按此顺序编排（`db:generate` → `build:api` → `typecheck` → `test` → `build:worker` → `build:web`）。
- 改动合并前跑 `pnpm lint:check`（只检查、不改文件）；`pnpm lint` 带 `--fix`，会在本地改文件，不要用在 CI。
- **模块边界由 `pnpm depcruise` 把关**（dependency-cruiser，CI 会跑）：模块之间只能通过对方的 service 通信，不得直接引用对方的 repository（持久化内部），也不得有循环依赖。现存越界（19 处跨模块 repository 访问、1 处 processing↔resource 循环）登记在 `.dependency-cruiser.cjs` 里并注明了原因，修好一处删一条；新增越界会被拦下。
- **枚举只有一份权威定义**：`packages/shared-types/src/enums.ts`。`apps/api/src/common/constants/enums.ts` 是 `pnpm sync:enums` 从它生成的，**不要手改**；CI 用 `pnpm check:enums` 校验同步。为什么不直接依赖：API 走 tsc，消费不了 shared-types 的裸 TS 源码，而给它加构建产物会让三个包多出构建顺序依赖、并在 watch 模式下静默用旧产物——原因写在 `scripts/sync-shared-enums.mjs` 顶部。

## 已知限制

前端 E2E、真实 multipart 上传、真实媒体处理链路尚未自动化；Docker Compose、备份与生产部署说明仍待整理。PostgreSQL、Redis/BullMQ、S3/MinIO 属于后续演进方向，当前默认运行不依赖它们。详细清单见 [docs/acceptance-checklist.md](docs/acceptance-checklist.md)。

前端目前只覆盖了纯逻辑层（`lib/` 的 api-client、format、resource）与少量基础组件，**页面级 / 交互流（1518 行的资源列表、设计发布流程）还没有测试**；后端 `design.service.ts`（2419 行 / 52 个方法）也只有 15 个用例，不足以支撑拆分。两者都属于待补。

## 相关文档

活文档（随实现更新）：

- [交付说明](docs/delivery-notes.md)
- [验收清单](docs/acceptance-checklist.md)

规划文档（阶段性冻结，不随代码更新）：

- [实施任务](docs/implementation-tasks.md)
- [平台总体方案](docs/resource-platform-plan.md)
- [外部资源接入与治理实施方案](docs/外部资源接入与治理实施方案.md) / [执行路径](docs/外部资源接入执行路径.md)
- [AI 设计运营方案](docs/ai-native-design-operations-plan.md)
