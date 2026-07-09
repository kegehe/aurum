# 资源管理平台

面向个人、工作室或小团队的多类型资源管理平台。统一采集、展示、管理、搜索和复用图片、视频、音频、文本、PDF、压缩包、游戏素材等各类资源。

## 功能概览

### 已实现（阶段 1-5）✅

| 功能 | 说明 |
|------|------|
| 文件上传 | 单文件 / 批量上传，支持任意类型文件 |
| 资源 CRUD | 列表（分页 + 筛选 + 排序）、详情、更新元数据 |
| 文件下载 | 流式下载，RFC 5987 文件名编码支持中文 |
| 软删除 / 恢复 | deletedAt 时间戳标记，回收站机制 |
| 去重检测 | SHA-256 哈希比对，上传时自动识别重复文件 |
| MIME 识别 | 基于 file-type（magic bytes）识别真实类型，不信任客户端声明 |
| 资源分类 | 9 个默认分类（图片/视频/音频/文档/游戏素材/设计素材/代码配置/压缩包/其他） |
| 资源标签 | 6 个测试标签，支持按标签筛选 |
| 存储安全 | 路径穿越 5 层防护，hash 分片目录结构 |

### 后续阶段规划

| 阶段 | 内容 |
|------|------|
| 阶段 6 | Worker 异步处理（元数据解析、缩略图生成） |
| 阶段 7 | 标签 / 分类 / 集合完整 CRUD |
| 阶段 8 | 全文搜索 |
| 阶段 9 | Next.js 前端 |
| 阶段 10-16 | 预览、回收站、统计、一致性检查、Docker 部署等 |

## 技术栈

| 层面 | 技术 |
|------|------|
| 运行时 | Node.js >= 20 |
| 后端框架 | NestJS 10 |
| ORM | Prisma 5 |
| 开发数据库 | SQLite（后续切 PostgreSQL） |
| 包管理 | pnpm workspace |
| 语言 | TypeScript 5.6（严格模式） |
| 文件存储 | 本地磁盘（后续支撑 MinIO / S3） |

## 快速开始

### 前置条件

```bash
# 需要 Node.js >= 20 和 pnpm >= 9
node -v   # >= 20
npm install -g pnpm
```

### 安装与启动

```bash
# 克隆仓库
git clone <repo-url>
cd resource_service

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example apps/api/.env

# 初始化数据库
pnpm db:migrate
pnpm db:seed

# 启动开发服务
pnpm dev:api
```

服务启动后访问 http://localhost:3000/api/health 返回：

```json
{ "status": "ok", "timestamp": "2026-07-08T..." }
```

## API 接口

所有接口前缀 `/api`。

### 健康检查

```
GET /api/health
```

### 上传

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload` | 单文件上传（字段名 `file`） |
| POST | `/api/upload/batch` | 批量上传（字段名 `files`） |

上传时可附带元数据字段（multipart form-data）：`title`、`description`、`categoryId`、`source`、`author`、`licenseNote`。

### 资源

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/resources` | 分页列表（支持筛选、排序） |
| GET | `/api/resources/:id` | 详情（含文件、标签、去重信息） |
| PATCH | `/api/resources/:id` | 更新元数据 |
| GET | `/api/resources/:id/download` | 下载原文件 |
| DELETE | `/api/resources/:id` | 软删除（进入回收站） |
| POST | `/api/resources/:id/restore` | 从回收站恢复 |

#### 列表查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| page | number | 页码（默认 1，最大 10000） |
| pageSize | number | 每页条数（默认 20，最大 100） |
| resourceType | string | 资源类型筛选（image/video/audio/text/document/archive） |
| categoryId | string | 分类 ID 筛选 |
| tagId | string | 标签 ID 筛选 |
| isFavorite | boolean | 是否收藏 |
| processingStatus | string | 处理状态筛选 |
| keyword | string | 关键词搜索（匹配标题、文件名、描述） |
| sortBy | string | 排序字段（createdAt/updatedAt/sizeBytes/title） |
| sortOrder | string | 排序方向（asc/desc，默认 desc） |
| includeDeleted | boolean | 是否包含已删除资源 |

### Curl 示例

```bash
# 上传文件
curl -X POST http://localhost:3000/api/upload \
  -F "file=@test.png" \
  -F "title=测试图片"

# 批量上传
curl -X POST http://localhost:3000/api/upload/batch \
  -F "files=@a.png" \
  -F "files=@b.png"

# 资源列表
curl http://localhost:3000/api/resources?page=1&pageSize=10

# 资源列表（按类型筛选）
curl "http://localhost:3000/api/resources?resourceType=image"

# 资源详情
curl http://localhost:3000/api/resources/<id>

# 更新资源
curl -X PATCH http://localhost:3000/api/resources/<id> \
  -H "Content-Type: application/json" \
  -d '{"title":"新标题","description":"新描述"}'

# 下载文件
curl -OJ http://localhost:3000/api/resources/<id>/download

# 软删除
curl -X DELETE http://localhost:3000/api/resources/<id>

# 恢复
curl -X POST http://localhost:3000/api/resources/<id>/restore
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| NODE_ENV | 运行环境 | development |
| PORT | 服务端口 | 3000 |
| DATABASE_URL | 数据库连接 | file:./prisma/dev.db |
| STORAGE_DRIVER | 存储驱动 | local |
| STORAGE_ROOT | 存储根目录（相对 apps/api） | ../../storage |
| MAX_UPLOAD_SIZE_MB | 单文件上传上限（MB） | 1024 |
| MAX_UPLOAD_TOTAL_SIZE_MB | 批量上传总上限（MB） | 5120 |
| TEMP_FILE_TTL_SECONDS | 临时文件保留时间（秒） | 3600 |
| CORS_ORIGIN | 生产环境允许的跨域来源（逗号分隔） | - |

## 项目结构

```
resource_service/
├── apps/
│   ├── api/                    # NestJS 后端 API
│   │   ├── prisma/             # 数据模型、迁移、种子数据
│   │   ├── src/
│   │   │   ├── main.ts         # 应用入口
│   │   │   ├── app.module.ts   # 根模块
│   │   │   ├── common/         # 公共设施
│   │   │   │   ├── config/     # 环境变量配置与校验
│   │   │   │   ├── constants/  # 枚举常量
│   │   │   │   ├── dto/        # 通用 DTO（分页）
│   │   │   │   ├── filters/    # 全局异常过滤器
│   │   │   │   └── interceptors/ # 全局日志拦截器
│   │   │   └── modules/
│   │   │       ├── prisma/     # 全局 PrismaService
│   │   │       ├── storage/    # 存储驱动（接口 + 本地实现）
│   │   │       ├── upload/     # 上传闭环
│   │   │       ├── resource/   # 资源 CRUD
│   │   │       ├── file/       # 资源文件仓储
│   │   │       ├── processing/ # 处理任务仓储
│   │   │       ├── tag/        # 标签模块（骨架）
│   │   │       ├── category/   # 分类模块（骨架）
│   │   │       ├── collection/ # 集合模块（骨架）
│   │   │       └── ...         # 其他骨架模块
│   │   └── .env
│   ├── worker/                 # Worker 进程（占位）
│   └── web/                    # Next.js 前端（占位）
├── packages/
│   └── shared-types/           # 前后端共享枚举与类型
├── storage/                    # 本地文件存储（gitignore）
│   ├── originals/
│   ├── thumbnails/
│   ├── previews/
│   ├── extracted-text/
│   └── temp/
├── docs/                       # 产品方案与实施文档
├── deploy/                     # 部署配置（占位）
├── .env.example                # 环境变量模板
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装所有依赖 |
| `pnpm dev:api` | 启动 API 开发服务（热重载） |
| `pnpm build:api` | 构建 API |
| `pnpm start:api` | 启动生产构建 |
| `pnpm typecheck` | 全项目类型检查 |
| `pnpm lint` | 全项目 ESLint 检查 |
| `pnpm format` | 格式化所有代码 |
| `pnpm db:migrate` | 运行数据库迁移 |
| `pnpm db:seed` | 填充种子数据 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm db:generate` | 重新生成 Prisma Client |

## 架构设计

### 请求处理流程（上传为例）

```
Client                    NestJS                         Storage
  │                          │                              │
  ├─ POST /api/upload ──────►│                              │
  │  (multipart form-data)   │                              │
  │                          ├─ multer diskStorage ──► temp/
  │                          │  (写临时文件)                 │
  │                          │                              │
  │                          ├─ SHA-256 流式计算             │
  │                          ├─ file-type MIME 识别          │
  │                          ├─ inferResourceType()         │
  │                          │                              │
  │                          ├─ generateKey() ────────────► │
  │                          ├─ put(stream) ──────────────► originals/ab/cd/...
  │                          │                              │
  │                          ├─ prisma.$transaction         │
  │                          │  ├─ findDuplicate (sha256)   │
  │                          │  ├─ create Resource          │
  │                          │  ├─ create ResourceFile      │
  │                          │  └─ create ProcessingJob     │
  │                          │                              │
  │◄─ { resource, isDuplicate }                             │
```

### 分层架构

```
Controller  ──►  Service  ──►  Repository  ──►  Prisma
   (路由)         (业务)         (数据访问)        (ORM)
```

- **Controller**：处理 HTTP 请求，参数校验和转换
- **Service**：业务逻辑编排，事务管理
- **Repository**：封装 Prisma 查询，支持事务客户端注入
- **Prisma**：数据库 ORM，类型安全的查询构建

### 存储安全

文件存储 key 采用 SHA-256 前 4 位分片，避免单目录文件过多：

```
生成规则: {role-dir}/{hash[0:2]}/{hash[2:4]}/{hash}.{suffix}.{variant}.{ext}
示例:     originals/ab/cd/abcdef1234567890.original.png
```

路径穿越防护（`resolvePath`）5 层校验：
1. 禁止空 key
2. 禁止绝对路径（`/` 和 `C:\` 等）
3. 禁止包含 `..` 和 `.` 路径段
4. 禁止 Windows 危险字符 `\`、`\0`、`:`
5. 解析后路径必须在 `STORAGE_ROOT` 范围内

## 注意事项

- **SQLite 开发限制**：SQLite 不支持 Prisma 原生 enum，枚举字段以 String 存储，应用层通过 `common/constants/enums.ts` 约束值。切换 PostgreSQL 时需改为 native enum。
- **BigInt 序列化**：`sizeBytes` 在数据库存储为 BigInt，所有 API 返回前统一转为字符串。
- **Multipart 请求**：上传接口的元数据不能通过 `@Body()` 装饰器获取（NestJS 在 multer 填充 body 前读取），改用 `@Req().body` 手动提取。
- **文件路径**：`STORAGE_ROOT` 是相对路径，从 `apps/api` 目录解析。开发时通过 `pnpm dev:api` 启动自动进入正确目录。
