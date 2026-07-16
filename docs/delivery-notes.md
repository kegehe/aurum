# 交付说明

## 当前交付范围

本次交付覆盖资源管理平台的本地开发版：

- API 与 Web 可本地启动。
- SQLite 数据库可迁移、seed。
- 支持上传、资源库、搜索筛选、标签、分类、集合、批量操作、回收站、处理任务、统计和一致性检查。
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

## 验收命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build:api
pnpm build:web
```

最近一次验收结果：

- `pnpm test`: 7 个测试文件，36 条测试通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm build:api`: 通过。
- `pnpm build:web`: 通过。

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

## 后续建议

1. 迁移 Web lint 到 ESLint CLI，消除 Next 16 兼容风险。
2. 用 Playwright 覆盖核心前端流程：上传、筛选、批量操作、回收站。
3. 增加上传 multipart 集成测试。
4. 增加真实媒体处理夹具和 Worker 处理测试。
5. 补齐 Docker Compose、备份、生产环境变量和部署说明。
