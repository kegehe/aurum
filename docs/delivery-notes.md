# 交付说明

## 当前交付范围

本次交付覆盖资源管理平台的本地开发版：

- API 与 Web 可本地启动。
- SQLite 数据库可迁移、seed。
- 支持上传、资源库、搜索筛选、标签、分类、集合、批量操作、回收站、处理任务、统计和一致性检查。
- 外部资源接入 P1-P3：来源配置管理、许可证管理、链接导入、SSRF 防护、元数据提取。
- 外部资源接入 P4：来源策略执行、许可证种子数据、链接健康检查、策略门禁。
- 已补充测试与验收文档。

## 启动步骤

```bash
pnpm install
cp .env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm db:seed
npx ts-node apps/api/prisma/seed-licenses.ts
pnpm dev
```

访问：

- Web: `http://localhost:3001`
- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`

## 验收命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:api
pnpm build:web
```

最近一次验收结果：

- `pnpm test`: 13 个测试文件，81 条测试通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm build:api`: 通过。
- `pnpm build:web`: 通过（14 个页面）。

## P4 新增功能

### 后端
- **LocatorHealthChecker**：HEAD/GET 探测 URL 可用性，获取 HTTP 状态、ETag、内容类型等
- **check_locator 任务处理**：IngestionService 支持 `check_locator` jobType，更新 ResourceLocator 健康信息
- **链接健康检查调度**：IngestionScheduler 定期扫描过期 locator，创建 check_locator 任务
- **策略门禁**：`assertDownloadAllowed` 方法，禁止禁用来源/未知许可/需审核来源的 mirror_file/archive_snapshot 任务
- **手动检查端点**：`POST /resources/:id/locators/check`
- **许可证种子数据**：10 条常见 SPDX 许可 + unknown，upsert 幂等

### 前端
- **来源管理页面**（/sources）：CRUD + 启用/禁用切换 + allowedModes 复选框 + 默认许可选择
- **许可证管理页面**（/licenses）：CRUD + 三态布尔标记（✓/✗/?）+ SPDX ID Badge
- **资源详情增强**：链接健康面板 + 来源追溯面板 + 许可状态 Badge + 失效链接警告
- **import-link 增强**：来源选择下拉框 + baseUrl 提示
- **侧边栏**：新增"来源管理"和"许可证管理"导航项

## 自动化测试覆盖

已覆盖：

- 搜索条件构建。
- 处理任务列表、统计、重试。
- 批量资源操作。
- 批量 DTO 校验。
- 集合批量加入资源。
- 集合资源关联仓储错误处理。
- 批量下载 ZIP 流与错误传播。
- 永久删除、清空回收站的文件/数据库删除顺序。
- 资源重新处理后的任务入队和处理状态同步。
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
