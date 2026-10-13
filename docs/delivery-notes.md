# 交付说明

## 当前交付范围

本次交付覆盖 Aurum 的本地开发版：

- API 与 Web 可本地启动。
- SQLite 数据库可迁移、seed。
- 支持上传、资源库、搜索筛选、分类、批量操作、回收站、处理任务、统计和一致性检查。
- 外部资源接入 P1-P3：来源配置管理、链接导入、SSRF 防护、元数据提取。
- 外部资源接入 P4：来源策略执行、链接健康检查、策略门禁。
- Civitai / GitHub / RSS 连接器与来源定时自动同步（GitHub 走官方 REST API：分页游标、ETag/If-None-Match、速率限制报错、Release 资产导入；RSS 支持 RSS 2.0 / Atom / JSON Feed，抓取走 SSRF 防护并逐跳校验，按 enclosure → media:content → 页面链接选择下载地址）。
- 页面快照（archive_snapshot 采集方式）：资源详情页手动触发 `capture_page` 任务，抓取页面 HTML 存为 `snapshot` 派生文件，受来源策略门禁约束。
  - **有意采用轻量实现**：只用 `SafeUrlService.fetchHtml`（DNS-pinning、逐跳重定向校验、2 MB 上限、必须返回 text/html），不引入无头浏览器。因此快照是服务端返回的骨架 HTML，**不含 JavaScript 渲染结果、子资源与懒加载内容**；需要渲染态存档时再按实施方案 P7/M5 评估 Playwright（限定网络、配额、超时、独立临时目录）。
  - 快照一律以 `attachment` 分发并带 `nosniff`；`/preview` 对 HTML/XHTML/XML 也降级为附件，避免不可信页面在本站源上执行脚本。
- 样式实验室（AI 视觉样式分析 + 本地降级）与页面内 AI 配置管理。
- AI 设计运营台（design 模块：文档/版本/候选/ChangeSet 原子发布/受控渲染）。
  - 本轮补齐：组件声明契约（`aurum.component.v2`，CSS 属性白名单 + token 别名）、
    新资产类型 `animation`（`aurum.animation.v1`，含 reducedMotion 必填）、
    真实效果渲染（组件渲真实元素与多状态并排、动画渲一页内胶片帧）、
    WCAG 对比度门禁（alpha 合成 + 大号文本 3:1，阻断发布）、
    CSS/Tailwind/`bundle` 导出（补齐曾经被静默丢弃的 cubicBezier 与 shadow 等六类 token）。
  - **修复了一处阻断性缺陷**：受控渲染器调用的 `design-preview` / `design-diff`
    两个 role 未注册，真实存储驱动下 `generateStorageKey` 必抛 `Unknown file role`，
    导致 render_validate 必然失败、候选永远无法进入 validated、**运营台一条都发布
    不出去**。测试没发现是因为渲染器 spec 自己伪造了 `generateKey`；现已改为委托
    真实实现并补了 role 注册表的全量断言。
  - 新增 `DELETE /design/candidates/:id`：人工候选原先只占名额、永不释放，加上没有
    删除入口，同一草稿连续 3 次失败即永久锁死。删除会一并回收预览产物。
  - **本轮补齐（面向外行的对话式创建）**：
    - **创建向导**（`/design-library`）：选配色 → 挑现成效果或描述一句 → 在实时预览里
      微调 → 一键发布。原来的专业界面整体移到 `/design-library/review`，两个入口互相链接。
    - **AI 输出自修复**：模型产出被 `validateDesignContent` 拒绝时，把错误原文回喂模型
      只修该处，最多两轮；整批只在一个合规候选都没有时才判失败，任务结果里带上失败
      标签与原因。此前一处格式错误会让**整批**候选丢失。
    - **参考图真的进提示词了**：`createReferenceDraft` 以前只写 ChangeSession +
      ReferenceSnapshot + 空草稿，参考内容从未进入模型——"粘贴图片生成"对结果零影响。
      现在参考段落进提示词，并显式剔除 `variations[].html`（方案 §15.8 不允许它变成组件）。
    - **一键保存并发布**（`POST /design/compose/publish`）：对比度门禁是纯函数，所以在
      写库**之前**同步跑完；不通过就一个字都不写，通过才建文档并把「渲染 → 选择 → 发布」
      交给 Worker（方案 §15.3）。
    - **反推控件**（`design-controls.ts`）：把已生成的声明按取值类别翻译成色板、token 档位、
      滑轨、下拉。只改已存在声明的值，且取值必须命中服务端自己给出的选项——所以滑块在
      结构上改不坏 schema，精调也不需要花 AI 调用。
    - **效果配方库**（`design-recipes.ts`，19 个）：3 套配色 + 4 按钮 + 5 卡片 + 3 文字 +
      4 动效。既是注入提示词的参考知识（模型自己写的"玻璃拟态"往往只有半透明背景，
      想不到 backdrop-filter + 内高光 + 半透明边框这套组合），也是"试试这些"芯片，
      更是**完全不花 AI 调用**的创建路径。
  - **本轮修掉的白名单缺陷**（都由新测试发现，不是配方写错）：
    - `border: 1px solid rgba(255, 255, 255, 0.35)` 被拒——边框简写按朴素空白切分，
      把 `rgba(...)` 切成了 4 段。最普通的一条边框声明根本写不出来。
    - `line-height: 1.25` 被拒——行高被归进 `length-list`，而设置行高最常见的写法
      就是无单位倍数。
    - 内置青色配色自身过不了 AA（白字压 `#0d9488` 只有 3.74:1），已压深至 `#0e7c72`（5.07:1）。
  - **本轮修掉的运行时缺陷**：`processNextTask` 的 AI 分支写成 `return this.processX(...)`
    而不是 `return await this.processX(...)`。JS 语义上 `try { return promise } catch` **不会**
    捕获该 promise 的 rejection（try 块成功求值并返回了），于是任何生成异常都让任务永远停在
    `running`，真实原因（"AI 未配置"、模型没返回 JSON）只剩一行日志，运营要等 lease 过期加重试
    三轮（约 20 分钟）才看到一句无信息量的 `LEASE_EXPIRED`。此缺陷对既有的 `ai_generate` 路径
    同样成立，已一并修掉。
- 处理任务可拆独立 Worker 进程（`@aurum/worker` 转发 `@aurum/api` 的 worker 入口）：环境变量决定本进程是否执行处理任务 / 是否跑摄入调度，默认保持单进程全开。
- 直连下载抽成独立连接器 `DirectDownloadConnector`（SSRF 逐跳重定向校验、限量流式落盘、SHA-256、魔数 MIME 识别、写正式存储），IngestionService 只保留任务控制与资源记录；来源同步 / 单资源镜像 / 后续批量下载与独立 Worker 共用同一份实现。
- 已移除集合（collection）、标签（tag）、许可证（license）模块。
- 已补充测试与验收文档。

## 启动步骤

```bash
pnpm install
cp .env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm db:seed
pnpm dev
```

访问：

- Web: `http://localhost:3001`
- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`

默认单进程即可跑完全部工作（API 进程内轮询并执行处理任务）。要把处理任务放到独立进程：

```bash
# 终端 1：API 只入队，不执行处理任务
EXECUTION_ENABLED=false pnpm dev:api
# 终端 2：Worker（自动关掉摄入调度，只跑处理任务）
pnpm dev:worker
```

两进程共享同一个 SQLite 库文件，因此 PrismaService 启动时会开 `journal_mode=WAL` 与
`busy_timeout=5000`；`STORAGE_ROOT` 与 `.env` 按 `apps/api` 目录解析，Worker 也必须以该目录
为工作目录启动（`@aurum/worker` 的 start 脚本已如此处理）。摄入调度（来源同步、下载）默认
仍留在 API 进程：其单飞标志与租约心跳只在单进程内成立，两进程同时轮询会打破该假设。

## 验收命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:api
pnpm build:web
```

最近一次验收结果（2026-10-13）：

- `pnpm test`: 43 个测试文件，594 条测试通过（API 39 文件 / 545 条，Web 4 文件 / 49 条）。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过（无错误、无警告，此前的 API unused-vars 警告已清零）。
- `pnpm check:enums`、`pnpm depcruise`: 通过（161 模块 / 594 依赖，无边界越界）。
- `pnpm build:api`、`pnpm build:worker`、`pnpm build:web`: 通过。
- 物理内存吃紧时 `pnpm test` 会 OOM：vitest 默认按 CPU 核数开 forks 池，Nest+Prisma
  的 worker 各自吃一份堆。本机复现门禁时加 `--maxWorkers=2` 即可（CI 的 windows runner
  不受影响，未写进脚本默认值）。
- 设计运营台端到端（隔离临时库 + 临时存储，25 项断言全通过）：创建主题 →
  组件 v2 钉版本 → 草稿 → 候选 → 渲染校验 → validated → 选择 → 发布 →
  bundle 导出；以及对比度不足的候选被门禁阻断、删除候选释放名额。

## P4 新增功能

### 后端

- **LocatorHealthChecker**：HEAD/GET 探测 URL 可用性，获取 HTTP 状态、ETag、内容类型等
- **check_locator 任务处理**：IngestionService 支持 `check_locator` jobType，更新 ResourceLocator 健康信息
- **链接健康检查调度**：IngestionScheduler 定期扫描过期 locator，创建 check_locator 任务
- **策略门禁**：`assertDownloadAllowed` 方法，禁止禁用来源/需审核来源的 mirror_file/archive_snapshot 任务
- **手动检查端点**：`POST /resources/:id/locators/check`

### 前端

- **来源管理页面**（/sources）：CRUD + 启用/禁用切换 + allowedModes 复选框
- **资源详情增强**：链接健康面板 + 来源追溯面板 + 失效链接警告
- **import-link 增强**：来源选择下拉框 + baseUrl 提示
- **侧边栏**：新增"来源管理"导航项

## 自动化测试覆盖

已覆盖：

- 搜索条件构建。
- 处理任务列表、统计、重试、临时文件清理。
- 批量资源操作与 DTO 校验。
- 资源服务/仓储、永久删除与回收站清空顺序。
- 上传分类校验报错。
- 外部资源接入：来源策略、SSRF 防护、Civitai/GitHub/LinkMetadata 连接器、导入任务与调度。
- 样式实验室：分析服务、Claude Vision（mock）、本地降级、CSS Tokens 导出。
- AI 配置管理与设计运营台工作流（含受控渲染）。
- 设计资产声明契约：属性白名单、别名解析、类型兼容、对比度门禁、导出器。
- 反推控件：取值类别到色板/档位/滑轨/下拉的映射，以及"控件改不动结构"的边界
  （越权取值被拒、只改已存在声明、产物仍过 schema）。
- 效果配方：19 个配方各自与**每一套**配色交叉验证结构与门禁（60 条交叉用例）。
  刻意不做成一张合并 token 表——合并会让后写的配色覆盖先写的，从而掩盖"某个配方
  配某套配色过不了门禁"（青色配色的 AA 缺陷就是这么漏掉的）。
- AI 修复重试：重试预算、错误分类（内容问题重试 / 租约与数据库错误冒泡）、修复调用
  自身失败时的降级，以及任务失败落库（守住 `return await` 的语义坑）。
- 端到端手工验证（本轮实跑）：配方编译、配色一键安装、控件编辑与越权拒绝、
  门禁拒绝零写入、一键发布走完渲染→选择→发布、版本历史、生成任务的失败原因可读。
- IngestionScheduler 健康检查调度。

详细清单见 [acceptance-checklist.md](acceptance-checklist.md)。

## 已知提示

当前不阻断交付的提示：

- `next lint` 已被 Next.js 标记为 deprecated，Next 16 会移除。
- Web lint/build 提示未检测到 Next ESLint plugin。
- 创建向导发布出来的资产会留下**两个内容相同的版本**：v1 由 `createDocument` 发布，
  v2 由自动发布流程在渲染记录落盘之后发布。副作用是审核台里这类资产的"视觉 Diff"
  恒为 0 像素（差异是相对内容相同的 v1 算的）。要消掉得给 `createDocument` 加
  "建而不发布"选项并放宽 `createDraft` 对基准版本的要求，会改动两个被广泛使用的方法，
  本轮刻意先接受这个瑕疵。
- 向导里的实时预览是**非权威视图**：iframe 注入由服务端从结构化内容派生出来的 CSS 与
  HTML 骨架，用于拖控件时的即时反馈。权威预览仍由受控渲染器产出（三视口 PNG + 像素 diff）。
  iframe 只是隔离手段，避免预览碰到运营台自身的 DOM，**不是发布安全边界**（方案 §8）。
- 对话生成的方案**不落库**：它是提案，不占候选名额、不建任何文档；只有用户点"保存并发布"
  的那一份才走完整的草稿 → 候选 → 渲染校验 → 选择 → 发布链。代价是刷新页面会丢掉还没
  保存的候选。
- 配方的 `use()` 会对缺失的 token 退回字面量，所以配方在任意主题下都能出效果；但用户
  自建的老主题若缺 `color.primary` 这类语义 token，成品会退化成不可换肤的固定色。
- 创建向导暂不支持**布局**（`layout`）类资产的对话生成：布局夹具仍是旧的 JSON 文本形态，
  AI 很容易产出"看着对但结构错"的布局，而当前没有能验证它的检查。

## 尚未自动化

- 上传接口真实 multipart 集成测试。
- Worker 对图片、视频、音频、文本、PDF 的真实处理测试。
- 前端浏览器端 E2E 测试。
- 移动端布局截图验收。
- LocatorHealthChecker 的 HTTP mock 集成测试。

## 后续建议

1. P5：受控直链下载与文件处理复用。
2. 迁移 Web lint 到 ESLint CLI，消除 Next 16 兼容风险。
3. 用 Playwright 覆盖核心前端流程：上传、筛选、批量操作、回收站。
4. 增加上传 multipart 集成测试。
5. 增加真实媒体处理夹具和 Worker 处理测试。
6. 补齐 Docker Compose、备份、生产环境变量和部署说明。
