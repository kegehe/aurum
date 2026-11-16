# Aurum

面向个人、工作室或小团队的多类型资源管理平台：上传、管理、预览、搜索、批量操作、回收站、处理任务、外部资源接入和统计看板。当前以本地 SQLite + 本地磁盘存储为开发运行方式。

## 能力

- **资源管理**：单文件/批量上传（SHA-256 去重、MIME 识别）、元数据编辑、下载与内联预览、缩略图、关键词/类型/分类/时间/大小的搜索筛选与排序、批量移动与收藏、软删除回收站、树形分类。
- **处理任务**：缩略图、转码、文本提取等异步任务。默认在 API 进程内轮询执行；设 `EXECUTION_ENABLED=false` 可把执行拆到独立 Worker 进程。
- **外部资源接入**：来源配置、链接导入、SSRF 防护（DoH 出站解析）、Civitai/GitHub/RSS 定时自动同步、页面 HTML 快照、链接健康检查与策略门禁；下载失败自动退避重试（最多 5 次）并可手动批量补漏，资源库直接标注「下载失败/待下载」。
- **AI**：样式实验室（视觉样式分析，未配置 Key 或调用失败时自动降级为本地确定性分析）、AI 设计运营台（设计资产版本化治理 + AI 候选 + 对比度门禁 + 受控渲染 + 只读导出，含**一句话创建**：只填一个输入框，类别（配色/组件/动效）、配色与命名都由模型判断 → 预览 → 一键发布；需要精细控制时走高级模式（选配色 → 挑现成效果 → 微调））、页面内运行时 AI 配置管理（多套 Key 切换、连通性测试，无需重启）。
- **统计与一致性**：概览与资源类型统计、存储文件一致性检查。
- **前端**：Next.js 15 管理界面 — 仪表盘、资源库与详情、上传、添加链接、任务中心、来源管理、处理任务、回收站、样式实验室、设计运营台（一句话生成 `/design-library`、高级模式 `/design-library/advanced`、审核台 `/design-library/review`）、设置（AI 配置）。

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
- SQLite: `apps/api/prisma/prisma/dev.db`（`DATABASE_URL` 相对 schema 目录解析，以实际 `.env` 为准），本地文件: `storage/`

默认 `pnpm dev` 会并发启动 API、Web、Worker 和独立渲染服务（入口 `scripts/dev.mjs`）。处理任务由 API 与 Worker 共同消费，`claimNext` 的原子认领保证同一任务不会被重复执行。只想让 Worker 执行、API 只入队时：

```bash
EXECUTION_ENABLED=false pnpm dev:api   # 只入队，不认领任务
pnpm dev:worker                        # 只跑处理任务，摄入调度仍留在 API
```

两进程共用一个 SQLite 库，启动时自动开启 `journal_mode=WAL` 与 `busy_timeout`；Worker 必须以 `apps/api` 为工作目录启动（`@aurum/worker` 的 start 脚本已如此处理）。

## 常用命令

| 命令                                      | 说明                                                    |
| ----------------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                                | 清理旧 dev 进程树后，构建并启动 API/Web/Worker/渲染服务 |
| `pnpm dev:api` / `dev:web` / `dev:worker` | 单独启动某个进程                                        |
| `pnpm test`                               | 运行 API 单元测试                                       |
| `pnpm typecheck` / `pnpm lint`            | 全 workspace 类型检查 / lint                            |
| `pnpm build:api` / `pnpm build:web`       | 生产构建                                                |
| `pnpm db:migrate` / `db:seed`             | Prisma 迁移 / 写入默认分类                              |
| `pnpm db:studio` / `pnpm db:generate`     | Prisma Studio / 重新生成客户端                          |

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
| `WORKER_STALE_JOB_TIMEOUT_MS` | 处理中任务超过该时长没有心跳视为卡死并自动回收 | `300000`（5 分钟） |
| `WORKER_MAX_EXECUTION_MS` | 单次执行超过该时长强制回收（兜底处理器挂起） | `1800000`（30 分钟） |
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
- **`pnpm dev` 的启动顺序**：入口是 `scripts/dev.mjs`。它先从 `node_modules/.cache/aurum-dev.json` 取上一次的包装进程 PID，用 `taskkill /T`（Windows）结束整棵 dev 进程树，再清理端口、构建、并发启动；Worker 会等 API 健康检查通过后再加载。正常重启不再每次走 WMI 全进程表查询；只有 PID 文件缺失或进程被强杀时才回退到 `pnpm clean:ports`（WMI 慢的机器可能多等数十秒）。强制结束 Next 后如果 `.next` 缓存不完整，启动入口会先清理它，避免 Web 500；完整缓存会保留。
- **首次启动/共享包变更后可能更慢**：preview/API 触发增量重编译时，Windows Defender 实时扫描会让构建和首次模块加载明显变慢；把项目目录、pnpm store、Playwright 浏览器目录加入排除项可以进一步稳定启动时间。
- **设计预览的重依赖是惰性加载的**：Playwright（`playwright-core`）只在真正渲染/截图时加载，Tailwind/esbuild 只在编译预览时加载。API/Worker/Renderer 启动不再同步拉起这些大依赖，首次打开预览/截图会略慢。
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
- [设计工作室 v2：资产库 + 工作台 + AI 接入](docs/design-studio-v2.md)
