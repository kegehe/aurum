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

最近一次验收结果（2026-09-21）：

- `pnpm test`: 29 个测试文件，298 条测试通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过（API 6 条 unused-vars 警告，无错误）。
- `pnpm build:api`: 通过。
- `pnpm build:web`: 通过。

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
- IngestionScheduler 健康检查调度。

详细清单见 [acceptance-checklist.md](acceptance-checklist.md)。

## 已知提示

当前不阻断交付的提示：

- `next lint` 已被 Next.js 标记为 deprecated，Next 16 会移除。
- Web lint/build 提示未检测到 Next ESLint plugin。

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
