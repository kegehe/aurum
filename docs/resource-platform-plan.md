# Aurum 产品与技术方案

## 1. 项目定位

本项目定位为 Aurum——一个面向个人、工作室或小团队内部使用的多类型资源管理平台。它不是普通网盘，也不是单一图片库，而是用于统一采集、展示、管理、搜索和复用各种资源的系统。

第一版重点解决以下问题：

- 各类资源分散在本地文件夹、聊天记录、项目目录和临时下载目录中，难以统一查找。
- 图片、视频、音频、文本、PDF、压缩包、游戏素材等类型没有统一的展示和管理方式。
- 资源缺少分类、描述、来源、许可证备注等元数据，后续复用时难以判断是否可用。
- 资源重复保存、命名混乱、版本不清晰，查找和整理成本高。
- 游戏素材、设计素材、参考资料等经常需要按项目包、主题包、角色包或场景包组织。

第一版不做用户权限体系和对外 API 集成，优先做一个单用户或内部可信环境下可用的资源管理工具。

## 2. 参考项目与调研结论

调研时参考了以下类型的开源或成熟项目：

- Immich：照片和视频管理系统，参考其上传、相册、时间线、元数据、相似搜索和机器学习能力。
  - https://github.com/immich-app/immich
- PhotoPrism：照片管理和搜索系统，参考其自动分类、EXIF/XMP 元数据、去重、隐私优先和 WebDAV 思路。
  - https://www.photoprism.app/features
- Paperless-ngx：文档管理系统，参考其 OCR、全文搜索、归档和文档元数据管理。
  - https://github.com/paperless-ngx/paperless-ngx
- Jellyfin：媒体服务器，参考其视频、音频、封面、媒体库和播放体验。
  - https://github.com/jellyfin/jellyfin
- ResourceSpace：数字资产管理系统，参考其 DAM 能力，包括资源元数据、转换、搜索、分享、工作流和统计。
  - https://www.resourcespace.com/features
- OpenAssetIO：创作和游戏/VFX 资产管线参考，关注资源身份、版本、依赖关系和工具链集成。
  - https://github.com/OpenAssetIO/OpenAssetIO

调研结论：

1. 资源管理系统的核心价值不只是上传文件，而是围绕资源建立可检索、可预览、可组织、可复用的资产库。
2. 第一版应避免做得过重。权限、审核流、开放 API、Webhook、企业审计等能力可以延后。
3. MVP 的关键是三件事：统一资源模型、可靠的文件处理流水线、好用的浏览和搜索体验。
4. 游戏资源需要被单独考虑，因为它经常包含复合文件、依赖关系、引擎版本、素材包和许可证问题。

## 3. 第一版范围

### 3.1 要做的功能

第一版包含以下能力：

- 资源上传
- 资源列表展示
- 资源详情页
- 图片、视频、音频、PDF、文本等基础预览
- 分类管理
- 资源集合/项目包
- 基础搜索和筛选
- 自动生成缩略图或预览信息
- 文件 hash 去重
- 批量操作
- 回收站
- 基础统计看板

### 3.2 暂不做的功能

以下能力第一版不做：

- 多用户登录
- 用户、角色、团队权限
- 资源级权限控制
- 公开分享链接
- API Key
- Webhook
- OpenAPI 文档
- 对外开放 API
- 第三方平台资源导入或 API 集成
- 企业级审计日志
- 复杂审核工作流
- 在线协作评论

说明：第一版仍然需要后端提供给前端调用的内部 HTTP 接口。这里暂不做的是对外开放 API、第三方平台集成、Webhook 和 API Key 体系。

### 3.3 设计上的保留空间

虽然第一版不做权限和 API，但数据模型和模块边界应保留扩展空间：

- 资源表中可以预留 `owner_id` 字段，但第一版固定为空或默认用户。
- 资源操作可记录简单操作日志，但不建设完整审计系统。
- 后台服务内部按模块拆分，未来可自然暴露 API。
- 文件存储抽象为 storage service，未来可从本地磁盘切换到 S3/MinIO。

## 4. 目标用户与典型场景

### 4.1 目标用户

第一阶段面向：

- 独立开发者
- 游戏开发者
- 设计师
- 内容创作者
- 小型工作室
- 需要整理大量素材和资料的个人用户

### 4.2 典型场景

#### 场景一：游戏开发素材管理

用户上传角色立绘、UI 图标、音效、BGM、shader、tileset、动画帧、模型文件和压缩包。系统生成缩略图，用户按项目、角色、场景、用途整理，并加入集合。

示例集合：

- 横版动作游戏角色包
- 森林场景 tileset
- UI 按钮和图标包
- 战斗音效包

#### 场景二：设计参考资料整理

用户上传大量参考图、截图、网页保存图、品牌资料和 PDF。系统按图片、PDF、文本分类展示，用户可以用分类和关键词快速检索。

#### 场景三：视频和音频资源整理

用户上传宣传视频、录屏、音效和背景音乐。系统生成视频封面、读取时长、格式和分辨率，音频显示基础信息，便于后续筛选。

#### 场景四：文本和文档归档

用户上传 Markdown、TXT、PDF、Word 文档。系统提取文本内容，支持关键词搜索。文档可按项目、知识类型、许可证状态进行分类。

## 5. 资源类型设计

系统应支持以下资源类型：

| 类型     | 示例格式                                    | 第一版处理方式                                                                          |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| 图片     | jpg, png, webp, gif, svg                    | 缩略图、尺寸、格式、颜色信息                                                            |
| 视频     | mp4, mov, webm, mkv                         | 封面帧、时长、分辨率、编码信息                                                          |
| 音频     | mp3, wav, ogg, flac                         | 时长、码率、格式、基础预览                                                              |
| 文本     | txt, md, json, csv, xml                     | 文本预览、全文索引                                                                      |
| 文档     | pdf, docx, pptx, xlsx                       | PDF 预览和文本提取；Office 文档第一版只记录元数据，不提取文本，后续增加 Office 文本提取 |
| 压缩包   | zip, rar, 7z, tar.gz                        | 文件信息、大小、备注                                                                    |
| 3D 模型  | glb, gltf, fbx, obj                         | 第一版记录元数据，后续增加 3D 预览                                                      |
| 字体     | ttf, otf, woff, woff2                       | 第一版记录元数据，后续增加字体预览                                                      |
| 游戏素材 | sprite sheet, tileset, prefab, unitypackage | 作为普通文件或集合管理，后续增加专项识别                                                |
| 链接资源 | url                                         | 第一版可暂缓，后续可保存网页标题、截图和摘要                                            |

## 6. 核心功能说明

### 6.1 资源上传

上传能力：

- 单文件上传
- 多文件批量上传
- 拖拽上传
- 上传进度显示
- 上传失败重试
- 上传后自动进入处理队列

上传时可填写：

- 标题
- 描述
- 分类
- 来源
- 作者
- 许可证备注
- 所属集合

上传后系统自动生成：

- 文件 hash
- 文件大小
- MIME 类型
- 文件扩展名
- 资源类型
- 图片尺寸或视频分辨率
- 视频/音频时长
- 缩略图或封面图

### 6.2 资源展示

资源库至少提供两种视图：

#### 网格视图

适合图片、视频、游戏素材和设计素材浏览。

展示内容：

- 缩略图
- 标题
- 类型图标
- 文件大小
- 收藏状态

#### 列表视图

适合文档、音频、压缩包和批量管理。

展示内容：

- 文件名或标题
- 类型
- 分类
- 大小
- 上传时间
- 更新时间
- 处理状态

### 6.3 资源详情页

资源详情页是资源管理的核心页面。

主要区域：

- 左侧或顶部：资源预览
- 右侧或下方：元数据面板
- 底部：关联资源、所属集合、处理记录

详情页字段：

- 标题
- 描述
- 文件名
- 资源类型
- MIME 类型
- 文件大小
- 文件 hash
- 分类
- 来源
- 作者
- 许可证备注
- 上传时间
- 更新时间
- 所属集合
- 处理状态

可执行操作：

- 修改标题
- 修改描述
- 修改分类
- 加入集合
- 下载原文件
- 删除到回收站

### 6.4 分类管理

分类用于建立相对稳定的资源结构，应尽量少而清晰。

建议默认分类：

- 图片
- 视频
- 音频
- 文档
- 游戏素材
- 设计素材
- 代码/配置
- 压缩包
- 其他

分类功能：

- 新建分类
- 编辑分类
- 删除分类
- 分类排序
- 查看分类下的资源

### 6.5 集合/项目包

集合用于把多个资源组织成一个可复用的资源包。

集合可以用于：

- 游戏项目素材包
- UI 组件包
- 角色素材包
- 关卡素材包
- 参考资料包
- 宣传物料包

集合字段：

- 名称
- 描述
- 封面
- 创建时间
- 更新时间
- 资源数量

集合功能：

- 新建集合
- 编辑集合
- 删除集合
- 添加资源到集合
- 从集合移除资源
- 下载集合内资源
- 按集合浏览资源

### 6.6 搜索与筛选

第一版搜索以关键词和结构化筛选为主。

搜索范围：

- 标题
- 描述
- 文件名
- 分类
- 来源
- 作者
- 文本文档内容
- PDF 抽取文本

筛选条件：

- 资源类型
- 分类
- 上传时间
- 文件大小
- 是否收藏
- 是否在回收站
- 处理状态

排序方式：

- 最近上传
- 最近更新
- 文件大小
- 标题
- 类型

后续可增强：

- 语义搜索
- 相似图片搜索
- 以图搜图

### 6.7 自动处理

资源上传后进入处理队列。

第一版处理任务：

- 计算 hash
- 判断是否重复
- 识别 MIME 类型
- 识别资源大类
- 图片生成缩略图
- 视频生成封面帧
- 视频读取时长和分辨率
- 音频读取时长
- PDF 提取文本
- TXT/MD/JSON/CSV 提取文本

处理状态（资源级 `processing_status`）：

- pending：有任务未完成
- processing：至少一个任务正在执行
- completed：所有必要任务已完成
- failed：至少一个必要任务失败

任务状态（任务级 `status`）：

- pending：等待执行
- processing：执行中
- completed：执行完成
- failed：执行失败
- canceled：已取消

处理失败时记录：

- 失败任务类型
- 错误信息
- 失败时间
- 是否可重试

### 6.8 去重

第一版基于文件 hash 去重。

上传文件后：

1. 计算 SHA-256 hash。
2. 查询是否存在相同 hash。
3. 如果存在重复资源，提示用户。
4. 用户可选择跳过、仍然保存或关联到已有资源。

第一版可以简化为：

- 默认允许保存重复文件。
- 在详情页和上传结果中提示“可能重复”。

后续增强：

- 图片感知 hash。
- 音频指纹。
- 视频相似度。
- 文档内容相似度。

### 6.9 批量操作

资源列表中支持多选。

批量操作：

- 批量修改分类
- 批量加入集合
- 批量收藏
- 批量取消收藏
- 批量下载
- 批量删除到回收站

### 6.10 回收站

删除资源时先进入回收站。

回收站功能：

- 查看已删除资源
- 恢复资源
- 彻底删除资源
- 清空回收站

彻底删除时应删除：

- 原文件
- 缩略图
- 预览文件
- 派生文件
- 相关处理记录

### 6.11 重新处理

当资源的处理任务失败或需要重新生成派生文件时，用户可以触发重新处理。

重新处理语义：

- 重新处理会为该资源创建新的处理任务，覆盖同类型的旧任务结果。
- 如果只重试失败任务，则只重新创建 failed 状态的任务。
- 如果用户选择"全部重新处理"，则先清理已有的派生文件（缩略图、封面、提取文本等），再重新创建所有类型的处理任务。
- 重新处理不会删除原文件，也不会修改资源的标题、描述、分类等元数据。
- 重新处理期间，资源 `processing_status` 回到 processing，已有的缩略图/封面仍可展示直到新文件生成。

触发入口：

- 资源详情页的"重新处理"按钮。
- 处理失败任务列表的"重试"按钮。

## 7. 页面规划

### 7.1 首页/仪表盘

首页用于快速了解资源库状态。

模块：

- 资源总数
- 各类型资源数量
- 最近上传
- 最近处理失败
- 收藏资源
- 最近集合

### 7.2 资源库页面

资源库是主要工作页面。

能力：

- 网格/列表切换
- 搜索框
- 类型筛选
- 分类筛选
- 排序
- 多选
- 批量操作
- 打开详情页

### 7.3 上传页面

上传页面用于批量导入资源。

能力：

- 拖拽上传
- 文件选择
- 上传队列
- 上传进度
- 上传结果
- 失败重试
- 上传前统一设置分类和集合

### 7.4 资源详情页面

用于预览和编辑单个资源。

能力：

- 图片预览
- 视频播放
- 音频播放
- PDF 预览
- 文本预览
- 元数据编辑
- 集合管理
- 下载原文件
- 删除

### 7.5 分类管理页面

用于维护分类结构。

能力：

- 分类列表
- 新建分类
- 重命名分类
- 删除分类
- 分类排序

### 7.6 集合页面

用于管理项目包和资源包。

能力：

- 集合列表
- 新建集合
- 编辑集合
- 查看集合内资源
- 从集合批量下载

### 7.7 回收站页面

用于恢复或彻底清理已删除资源。

能力：

- 已删除资源列表
- 恢复
- 彻底删除
- 清空回收站

## 8. 数据模型草案

### 8.1 resources

资源主表。

| 字段              | 类型     | 说明                                                           |
| ----------------- | -------- | -------------------------------------------------------------- |
| id                | uuid     | 资源 ID                                                        |
| title             | string   | 标题                                                           |
| description       | text     | 描述                                                           |
| original_filename | string   | 原始文件名                                                     |
| resource_type     | string   | 资源类型                                                       |
| mime_type         | string   | MIME 类型                                                      |
| extension         | string   | 扩展名                                                         |
| size_bytes        | bigint   | 文件大小                                                       |
| sha256            | string   | 文件 hash                                                      |
| category_id       | uuid     | 分类 ID                                                        |
| source            | string   | 来源                                                           |
| author            | string   | 作者                                                           |
| is_favorite       | boolean  | 是否收藏                                                       |
| processing_status | string   | 处理状态                                                       |
| duplicate_of_id   | uuid     | 重复资源 ID                                                    |
| width             | integer  | 宽度（冗余自原文件，用于列表展示）                             |
| height            | integer  | 高度（冗余自原文件，用于列表展示）                             |
| duration_seconds  | decimal  | 时长（冗余自原文件，用于列表展示）                             |
| search_vector     | tsvector | 全文检索向量（PostgreSQL tsvector，由提取文本和标题/描述生成） |
| created_at        | datetime | 创建时间                                                       |
| updated_at        | datetime | 更新时间                                                       |
| deleted_at        | datetime | 删除时间                                                       |

说明：`width`、`height`、`duration_seconds` 在 `resource_files` 中保存每个具体文件的真实参数，在 `resources` 中冗余原文件的参数用于列表页高频展示，避免列表查询时 join `resource_files`。Worker 处理完成后同步回写 `resources` 上的冗余字段。

### 8.2 resource_files

文件表，记录原文件和派生文件。

| 字段             | 类型     | 说明                                                                            |
| ---------------- | -------- | ------------------------------------------------------------------------------- |
| id               | uuid     | 文件 ID                                                                         |
| resource_id      | uuid     | 资源 ID                                                                         |
| file_role        | string   | original, thumbnail, preview, extracted_text, transcode                         |
| variant          | string   | 变体标识，默认为空；用于同一角色多文件场景，如 PDF 多页缩略图（page-1, page-2） |
| storage_path     | string   | 存储路径                                                                        |
| mime_type        | string   | MIME 类型                                                                       |
| extension        | string   | 文件扩展名，如 webp、jpg、txt                                                   |
| size_bytes       | bigint   | 文件大小                                                                        |
| width            | integer  | 宽度                                                                            |
| height           | integer  | 高度                                                                            |
| duration_seconds | decimal  | 时长                                                                            |
| created_at       | datetime | 创建时间                                                                        |

### 8.3 categories

分类表。

| 字段       | 类型     | 说明      |
| ---------- | -------- | --------- |
| id         | uuid     | 分类 ID   |
| name       | string   | 分类名称  |
| parent_id  | uuid     | 父分类 ID |
| sort_order | integer  | 排序      |
| created_at | datetime | 创建时间  |
| updated_at | datetime | 更新时间  |

### 8.4 collections

集合表。

| 字段              | 类型     | 说明     |
| ----------------- | -------- | -------- |
| id                | uuid     | 集合 ID  |
| name              | string   | 集合名称 |
| description       | text     | 描述     |
| cover_resource_id | uuid     | 封面资源 |
| created_at        | datetime | 创建时间 |
| updated_at        | datetime | 更新时间 |
| deleted_at        | datetime | 删除时间 |

### 8.5 collection_resources

集合资源关联表。

| 字段          | 类型     | 说明     |
| ------------- | -------- | -------- |
| collection_id | uuid     | 集合 ID  |
| resource_id   | uuid     | 资源 ID  |
| sort_order    | integer  | 排序     |
| added_at      | datetime | 加入时间 |

### 8.6 processing_jobs

后台处理任务表。

| 字段          | 类型     | 说明     |
| ------------- | -------- | -------- |
| id            | uuid     | 任务 ID  |
| resource_id   | uuid     | 资源 ID  |
| job_type      | string   | 任务类型 |
| status        | string   | 状态     |
| error_message | text     | 错误信息 |
| retry_count   | integer  | 重试次数 |
| started_at    | datetime | 开始时间 |
| finished_at   | datetime | 完成时间 |
| created_at    | datetime | 创建时间 |

说明：`processing_jobs` 表与 BullMQ 队列的分工如下：

- BullMQ 负责任务调度、并发控制、重试策略和超时管理，是运行时的事实来源。
- `processing_jobs` 表在任务创建时写入 pending 记录，在 Worker 开始执行时更新为 processing，在完成或失败时更新最终状态和错误信息，用于持久化展示、失败重试入口和统计查询。
- BullMQ 的重试次数与表中 `retry_count` 应保持同步：每次 BullMQ 重试时 Worker 回写 `retry_count`。
- 如果 BullMQ 中的任务丢失（如 Redis 重启且未持久化），可通过 `processing_jobs` 表中 status 长期为 pending 或 processing 的记录发现并重新入队。

### 8.7 枚举与约束

建议第一版明确以下枚举，避免后续代码中出现随意字符串。

资源类型 `resource_type`：

- image
- video
- audio
- text
- document
- archive
- model3d
- font
- game_asset
- other

文件角色 `file_role`：

- original
- thumbnail
- preview
- extracted_text
- transcode

资源处理状态 `processing_status`（资源级，反映该资源所有处理任务的整体状态）：

- pending：有任务未完成
- processing：至少一个任务正在执行
- completed：所有必要任务已完成
- failed：至少一个必要任务失败（不影响其他已完成任务的结果）

任务状态 `status`（任务级，反映单个处理任务的执行状态）：

- pending：等待执行
- processing：执行中
- completed：执行完成
- failed：执行失败
- canceled：已取消（用户主动取消或资源被删除导致任务取消）

说明：资源级 `processing_status` 和任务级 `status` 是两套枚举。一个资源可能有多个任务，资源级状态由所有任务状态聚合得出：任一任务 processing 则资源 processing；全部 completed 则资源 completed；存在 failed 且无 processing 则资源 failed；其余为 pending。任务 canceled 不影响资源级状态判断。

任务类型 `job_type`：

- detect_metadata
- generate_thumbnail
- generate_video_cover
- extract_text
- detect_duplicate
- cleanup_files
- cleanup_temp

建议约束：

- `categories.name + parent_id` 唯一。
- `collection_resources.collection_id + resource_id` 唯一。
- `resource_files.resource_id + file_role + variant` 唯一；`variant` 默认为空字符串，同一角色同一变体只允许一个文件。
- `resources.sha256` 不强制唯一，因为第一版允许重复保存，但要建立索引用于去重提示。

### 8.8 关键索引

第一版建议建立以下索引：

- `resources.created_at`
- `resources.updated_at`
- `resources.deleted_at`
- `resources.resource_type`
- `resources.category_id`
- `resources.sha256`
- `resources.processing_status`
- `resources.is_favorite`
- `resources.width`
- `resources.height`
- `resources.duration_seconds`
- `resource_files.resource_id`
- `resource_files.file_role`
- `collection_resources.collection_id`
- `processing_jobs.resource_id`
- `processing_jobs.status`
- `processing_jobs.job_type`
- `processing_jobs.created_at`

搜索相关索引：

- `resources.title`
- `resources.description`
- `resources.original_filename`
- `resources.search_vector`（PostgreSQL GIN 索引，用于全文检索）

说明：`resources.search_vector` 由标题、描述和提取文本合并生成，Worker 处理完成后通过 `to_tsvector` 更新。第一版使用 PostgreSQL 原生全文检索，后续可迁移到 Meilisearch/OpenSearch。

## 9. 系统架构设计

### 9.1 架构目标

第一版架构应优先满足以下目标：

1. 简单可运行：本地或单台服务器即可部署，不需要复杂微服务。
2. 模块边界清晰：虽然第一版采用模块化单体，但上传、存储、处理、搜索、资源管理之间要有明确边界。
3. 文件处理异步化：上传请求不等待视频截图、PDF 提取、缩略图生成等重任务完成。
4. 存储可替换：第一版可以使用本地磁盘，后续可以替换为 MinIO/S3。
5. 搜索可演进：第一版使用 PostgreSQL 完成基础搜索，后续可接 Meilisearch、OpenSearch 或向量检索。
6. 类型可扩展：新增 3D 模型、字体、游戏引擎资源包时，不需要重写主流程。
7. 权限和 API 可后加：第一版不做权限和对外 API，但架构不能把这些能力彻底堵死。

### 9.2 总体架构

第一版建议采用“前后端分离 + 模块化单体 + 异步任务 Worker + 文件存储”的架构。

```text
┌─────────────────────────────────────────────────────────────┐
│                         Web Frontend                         │
│  资源库 / 上传 / 详情 / 分类 / 集合 / 回收站 / 看板         │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────────┐
│                       Backend Application                    │
│                                                             │
│  Resource  Upload  Category  Collection  Search  Trash  │
│      │       │         │          │          │      │    │
│      └───────┴─────────┴──────────┴──────────┴──────┘    │
│                    Application Service Layer                 │
└───────────────┬──────────────────────┬──────────────────────┘
                │                      │
                │ SQL                  │ Queue
┌───────────────▼──────────────┐       │
│          PostgreSQL           │       │
│  resources / categories / jobs ...  │       │
└──────────────────────────────┘       │
                                       │
┌──────────────────────────────────────▼──────────────────────┐
│                       Processing Worker                      │
│  hash / thumbnail / video cover / metadata / text extraction │
└───────────────┬──────────────────────┬──────────────────────┘
                │                      │
                │ file read/write      │ optional cache/queue state
┌───────────────▼──────────────┐   ┌───▼──────────────────────┐
│       File Storage            │   │ Redis / Queue Backend     │
│ originals / thumbnails / ...  │   │ pending / retry / status  │
└──────────────────────────────┘   └──────────────────────────┘
```

### 9.3 运行时组件

第一版包含以下核心运行时组件。

| 组件                | 职责                                                        | 第一版建议             |
| ------------------- | ----------------------------------------------------------- | ---------------------- |
| Web Frontend        | 页面展示、上传交互、资源管理操作                            | Next.js                |
| Backend Application | 业务接口、数据库读写、任务创建、文件下载                    | NestJS                 |
| Processing Worker   | 异步处理文件、生成派生资源、更新状态；直接读写 File Storage | NestJS + BullMQ Worker |
| PostgreSQL          | 保存资源元数据、分类、集合、任务状态                        | 主数据库               |
| File Storage        | 保存原文件、缩略图、预览文件、提取文本                      | 本地磁盘起步           |
| Queue Backend       | 任务队列、重试、异步解耦                                    | Redis + BullMQ         |

第一版直接引入 Redis + BullMQ，不建议用数据库轮询代替队列。资源处理天然包含耗时任务，队列越早稳定，后续缩略图、视频封面、PDF 提取、失败重试和 Worker 扩展越容易。

### 9.4 架构决策

本项目第一版确定采用 TypeScript 全栈模块化单体架构。

最终选型：

- 前端：Next.js
- 后端：NestJS
- ORM：Prisma
- 数据库：PostgreSQL
- 队列：Redis + BullMQ
- Worker：独立 NestJS Worker 进程
- 图片处理：Sharp
- 视频音频处理：FFmpeg
- PDF 处理：pdf-parse（纯 JS，第一版用于文本型 PDF 提取；扫描型 PDF 的 OCR 留待后续 AI Worker）
- 文件存储：本地磁盘，后续 MinIO/S3
- 包管理：pnpm
- 部署：Docker Compose

选择这个方案的原因：

1. 前后端统一 TypeScript，接口类型、DTO、校验规则和开发体验更一致。
2. NestJS 的模块结构适合资源、上传、分类、集合、搜索、处理任务等领域拆分。
3. BullMQ 适合处理图片缩略图、视频封面、PDF 文本提取这类异步任务。
4. PostgreSQL 足够支撑第一版的元数据、分类、集合、全文检索和统计。
5. Worker 独立进程可单独扩容，不会拖慢主 API。
6. 本地文件存储能降低第一版部署复杂度，storage module 保留后续迁移 MinIO/S3 的空间。

暂不选择 Python 作为主后端，原因是第一版更需要快速完成 Web 产品闭环和稳定工程结构。后续如果需要 OCR、语义搜索或复杂文档分析，可以增加独立 Python AI Worker，而不是替换主后端。

### 9.5 目标架构栈

第一版目标架构：

```text
Next.js Web
  -> NestJS API
      -> Prisma
      -> PostgreSQL
      -> Redis/BullMQ
      -> Local Storage（读写原文件、下载）
  -> NestJS Worker
      -> Local Storage（读写原文件、写入派生文件）
      -> Sharp
      -> FFmpeg
      -> pdf-parse
```

后续增强路径：

- 存储增强：Local Storage -> MinIO/S3。
- 搜索增强：PostgreSQL full-text search -> Meilisearch/OpenSearch。
- AI 增强：增加 Python AI Worker + pgvector。
- 预览增强：增加 3D 模型预览、音频波形、PDF 页面缩略图。

### 9.6 模块边界

后端应按领域模块拆分，而不是按数据库表拆分。

| 模块               | 职责                                                   |
| ------------------ | ------------------------------------------------------ |
| resource module    | 资源主数据、详情、更新、删除、恢复                     |
| upload module      | 接收上传、临时文件、hash、创建资源记录                 |
| storage module     | 原文件和派生文件的保存、读取、删除、路径生成           |
| processing module  | 创建任务、调度 Worker、更新处理状态                    |
| metadata module    | MIME、尺寸、时长、EXIF、PDF 文本等元数据解析           |
| preview module     | 缩略图、视频封面、PDF 预览等派生文件生成               |
| search module      | 关键词搜索、筛选、排序、全文索引                       |
| category module    | 分类增删改查和分类树                                   |
| collection module  | 集合和集合资源关系                                     |
| trash module       | 软删除、恢复、彻底删除                                 |
| stats module       | 首页统计、类型数量、最近上传、失败任务                 |
| consistency module | 数据库与文件存储一致性检查、孤儿文件清理、临时文件清理 |

storage module 接口契约（后续切换 MinIO/S3 只需实现此接口的另一个驱动）：

```text
StorageService
  put(key: string, data: Buffer | Stream, metadata?: FileMetadata): Promise<string>
  get(key: string): Promise<Buffer | Stream>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  generateKey(role: FileRole, hash: string, variant?: string, extension?: string): string
  getPublicUrl?(key: string): string  // S3/MinIO 驱动使用
```

说明：`generateKey` 根据文件角色、hash 前缀分片、变体和扩展名生成相对路径。本地驱动返回相对路径，S3 驱动返回 object key。所有模块通过 `StorageService` 接口操作文件，不直接使用 `fs` 模块。

模块依赖原则：

- resource module 可以调用 storage、processing、category、collection。
- upload module 只负责上传入口，不直接生成复杂预览。
- processing module 可以调用 metadata、preview、storage。
- search module 读取资源、分类和提取文本，但不修改资源主数据。
- trash module 负责删除流程编排，真正的文件删除通过 storage module 完成。
- consistency module 读取 storage 和数据库，不修改资源主数据，清理操作通过 trash 和 storage module 完成。

### 9.7 分层设计

后端内部建议分为四层。

```text
Controller / Route
  接收 HTTP 请求，做参数校验，返回 DTO

Application Service
  编排业务流程，例如上传、删除、批量分类、加入集合

Domain Service
  处理领域规则，例如资源类型识别、重复判断、状态流转

Infrastructure
  数据库、文件存储、队列、FFmpeg、Sharp、PDF 工具等外部依赖
```

示例：

```text
UploadController
  -> UploadService
      -> StorageService
      -> ResourceRepository
      -> ProcessingJobService
          -> QueueAdapter
```

这样做的好处是：未来把本地文件存储替换成 S3，只需要改 storage infrastructure；未来把数据库搜索替换成 Meilisearch，只需要改 search infrastructure。

### 9.8 核心数据流

#### 上传数据流

```text
用户选择文件
  -> Frontend 上传到 Backend
  -> Backend 保存到临时目录
  -> 计算 SHA-256
  -> 识别基础 MIME 和扩展名
  -> 移动到正式存储目录
  -> 写入 resources 和 resource_files
  -> 创建 processing_jobs
  -> 返回资源记录和 pending 状态
  -> Worker 异步处理
  -> 更新资源元数据和预览文件
  -> Frontend 轮询或刷新看到完成状态
```

#### 搜索数据流

```text
用户输入关键词和筛选条件
  -> Frontend 请求 Backend Search
  -> Search module 组合查询条件
  -> PostgreSQL 查询 resources/categories/resource_files
  -> 返回分页结果
  -> Frontend 渲染网格或列表
```

后续接搜索引擎后：

```text
资源变更
  -> 触发索引更新任务
  -> Search Index 写入 Meilisearch/OpenSearch
  -> 查询时优先访问 Search Index
  -> 根据 resource_id 回表补齐必要信息
```

#### 删除数据流

```text
用户删除资源
  -> 更新 resources.deleted_at
  -> 资源从默认列表隐藏
  -> 回收站页面仍可查询
```

彻底删除：

```text
用户彻底删除
  -> 查询资源关联文件
  -> Storage 删除原文件和派生文件
  -> 删除资源关联关系
  -> 删除 processing_jobs
  -> 删除 resource_files
  -> 删除 resources
```

### 9.9 存储架构

系统要区分“元数据存储”和“二进制文件存储”。

#### 元数据

保存在 PostgreSQL 中：

- 资源标题、描述、类型、大小、hash
- 分类、集合
- 文件存储路径
- 处理任务状态
- 软删除状态

#### 文件数据

保存在文件存储中：

- 原文件
- 缩略图
- 视频封面
- PDF 预览
- 提取文本
- 后续转码文件

#### 文件路径策略

如果使用本地文件存储，可按 hash 分目录：

```text
storage/
  originals/
    ab/
      cd/
        abcd...original.png
  thumbnails/
    ab/
      cd/
        abcd...thumb.webp
  previews/
    ab/
      cd/
        abcd...preview.jpg
  extracted-text/
    ab/
      cd/
        abcd...txt
  temp/
    upload-session-id/
      uploading.tmp
```

路径规则：

- 使用 hash 前几位分片，避免单目录文件过多。
- 原始文件不可被预览处理覆盖。
- 派生文件可以删除后重建。
- 数据库只保存相对路径或 storage key，不保存绝对路径。
- 文件名不要依赖用户上传文件名，用户文件名只保存在元数据中。

### 9.10 后台任务架构

文件处理必须走后台任务，避免上传接口阻塞。

任务类型：

- detect_metadata：识别 MIME、尺寸、时长、编码信息。
- generate_thumbnail：生成图片缩略图。
- generate_video_cover：生成视频封面。
- extract_text：提取文本或 PDF 内容。
- detect_duplicate：重复资源检查。
- cleanup_files：彻底删除后的文件清理。
- cleanup_temp：清理临时上传目录中超过一定时间（建议 1 小时）的孤儿文件，防止上传中断后临时文件堆积。

任务状态（详见 8.7 枚举定义）：

- pending：等待执行
- processing：执行中
- completed：执行完成
- failed：执行失败
- canceled：已取消

任务执行原则：

- 每个任务要可重试。
- 重试次数要有限制。
- 任务失败不能影响资源主记录访问。
- 派生文件生成失败时，资源仍可下载原文件。
- 任务执行要有超时时间，尤其是视频和 PDF。
- Worker 可以横向扩展，但第一版单 Worker 即可。

### 9.11 搜索架构

第一版搜索可以分两个层次实现。

#### 第一层：数据库搜索

适合 MVP：

- 标题模糊搜索
- 描述模糊搜索
- 文件名搜索
- 分类筛选
- 类型筛选
- 上传时间筛选

PostgreSQL 可使用：

- 普通 B-tree 索引
- `GIN` 索引用于数组或全文搜索
- `tsvector` 做基础全文检索

第一版全文检索实现：

- `resources.search_vector` 字段（tsvector 类型）由标题、描述和提取文本合并生成。
- Worker 完成文本提取后，通过 `to_tsvector('simple', title || ' ' || description || ' ' || extracted_text)` 更新 `search_vector`。
- 查询时使用 `WHERE search_vector @@ to_tsquery('simple', keywords)` 进行全文匹配。
- `search_vector` 字段建立 GIN 索引（见 8.8）。

#### 第二层：独立搜索引擎

资源数量变大后再引入：

- Meilisearch：轻量、好部署、适合后台管理搜索。
- OpenSearch：功能更强，适合复杂全文检索和聚合。

独立搜索引擎中的索引文档可以包含：

- resource_id
- title
- description
- original_filename
- resource_type
- category
- source
- author
- extracted_text

#### 第三层：语义搜索

后续做 AI 能力时再引入：

- 图片 embedding
- 文本 embedding
- 音视频摘要 embedding
- PostgreSQL pgvector 或独立向量数据库

第一版不建议直接做语义搜索，以免拉高复杂度。

### 9.12 预览架构

预览文件应作为原文件的派生资源管理。

```text
resource
  -> original file
  -> thumbnail file
  -> preview file
  -> extracted text file
```

原则：

- 原文件是事实来源。
- 预览文件可以随时重建。
- 预览失败不影响原文件下载。
- 不同类型资源使用不同预览策略。

预览策略：

| 类型        | 预览方式                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| 图片        | 生成 webp 缩略图，详情页展示原图或压缩预览                               |
| 视频        | 生成封面帧，详情页使用浏览器播放器播放原视频或可播放转码文件             |
| 音频        | 浏览器播放器播放，后续可生成波形                                         |
| PDF         | 第一版可浏览器内嵌预览，后续生成页面缩略图                               |
| Office 文档 | 第一版只展示文件元数据，不提取文本和预览，后续增加 Office 文本提取和预览 |
| 文本        | 直接展示提取文本                                                         |
| 压缩包      | 展示文件元数据，不展开内容                                               |
| 3D 模型     | 第一版展示文件信息，后续接 three.js 预览                                 |

### 9.13 部署架构

#### 本地开发部署

```text
Frontend dev server
Backend dev server
PostgreSQL
Redis
Local storage directory
Worker process
```

适合开发调试。

#### 单机生产部署

```text
Nginx
  -> Frontend static/SSR
  -> Backend API

Backend API
Worker
PostgreSQL
Redis
Local disk or mounted data volume
```

适合个人或小团队内部使用。

#### Docker Compose 部署

推荐第一版提供 Docker Compose：

```text
services:
  web
  api
  worker
  postgres
  redis

volumes:
  postgres-data
  redis-data
  storage-data
```

这样后续迁移到服务器比较直接。

### 9.14 配置与环境变量

建议通过环境变量管理配置：

```text
DATABASE_URL=
REDIS_URL=
STORAGE_DRIVER=local
STORAGE_ROOT=./storage
MAX_UPLOAD_SIZE_MB=1024
MAX_UPLOAD_TOTAL_SIZE_MB=5120
ALLOWED_FILE_TYPES=
FFMPEG_PATH=
IMAGE_PROCESSOR=sharp
WORKER_CONCURRENCY=2
TEMP_FILE_TTL_SECONDS=3600
```

后续切换 MinIO/S3 时增加：

```text
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_REGION=
```

### 9.15 错误处理与恢复

架构上需要承认文件处理会失败。

常见失败：

- 上传中断。
- 文件类型识别失败。
- 视频文件损坏。
- FFmpeg 处理超时。
- PDF 加密或格式异常。
- 缩略图生成失败。
- 文件已在磁盘丢失，但数据库记录仍存在。

处理策略：

- 上传阶段失败，不创建资源记录或标记为 upload_failed。
- 处理阶段失败，资源保留，任务标记 failed。
- 详情页展示处理失败原因。
- 用户可以手动重试处理任务。
- 定期检查数据库记录和文件存储是否一致。
- 彻底删除使用后台 cleanup 任务，失败可重试。

### 9.16 架构演进路线

#### MVP 架构

```text
Next.js + NestJS API + NestJS Worker + PostgreSQL + Redis/BullMQ + Local Storage
```

搜索使用 PostgreSQL，任务队列使用 Redis/BullMQ。这个版本已经具备完整资源管理闭环。

#### 标准单机架构

```text
Next.js + NestJS API + NestJS Worker + PostgreSQL + Redis/BullMQ + Local Storage + Nginx
```

增加 Nginx 和生产部署配置，适合个人或小团队在单台服务器长期运行。

#### 小团队生产架构

```text
Next.js + NestJS API + NestJS Worker + PostgreSQL + Redis/BullMQ + MinIO
```

文件存储迁移到对象存储，便于备份和扩容。

#### 增强搜索架构

```text
Next.js + NestJS API + NestJS Worker + PostgreSQL + Redis/BullMQ + MinIO + Meilisearch/OpenSearch
```

全文搜索和复杂筛选交给搜索引擎。

#### AI 增强架构

```text
Next.js + NestJS API + NestJS Worker + Python AI Worker + PostgreSQL + Redis/BullMQ + MinIO + Search Engine + Vector Index
```

增加相似图片、语义搜索、OCR 和内容理解。

## 10. 处理流水线

上传后的推荐流程：

1. 接收文件并保存到临时目录。
2. 计算 SHA-256 hash。
3. 根据 hash 生成最终存储路径。
4. 移动文件到原文件目录。
5. 创建 resources 记录。
6. 创建 resource_files 原文件记录。
7. 创建 processing_jobs。
8. 后台任务识别 MIME 类型和资源类型。
9. 根据类型执行缩略图、封面、文本提取等任务。
10. 更新资源处理状态。

不同类型的处理：

| 类型        | 处理任务                         |
| ----------- | -------------------------------- |
| 图片        | 读取尺寸、生成 webp 缩略图       |
| 视频        | 读取时长、分辨率、生成封面帧     |
| 音频        | 读取时长、码率                   |
| PDF         | 生成预览、提取文本               |
| Office 文档 | 第一版只记录文件信息，不提取文本 |
| 文本        | 提取文本内容                     |
| 压缩包      | 记录格式和大小                   |
| 3D 模型     | 第一版只记录文件信息             |
| 游戏素材包  | 第一版作为普通资源或集合管理     |

## 11. 前端体验原则

第一版界面应偏工具型，不做营销页。

设计原则：

- 首页直接进入资源管理体验。
- 资源库页面应支持高密度信息浏览。
- 图片、视频类资源优先使用网格预览。
- 文档、音频、压缩包优先使用列表视图。
- 筛选、搜索、批量操作要在资源库页面直接可用。
- 详情页应让用户快速编辑分类、描述和集合。
- 上传页面要清晰展示处理状态和失败原因。

## 12. 工程约束与验收口径

### 12.1 上传安全

即使第一版不做权限，也必须把文件上传当成不可信输入处理。

基础要求：

- 限制单文件大小和批量上传总大小。
- 使用服务端 MIME 识别，不完全相信浏览器上传的 `Content-Type`。
- 文件名只作为元数据保存，不直接作为磁盘文件名。
- 存储路径由系统生成，避免路径穿越。
- 调用 FFmpeg、Poppler 等外部命令时设置超时。
- 对压缩包第一版不自动解压，避免压缩炸弹和路径穿越问题。
- 原文件、缩略图、预览文件分目录保存。
- 下载文件时通过资源 ID 查询 storage key，不允许客户端直接传入任意磁盘路径。

### 12.2 数据一致性

资源系统同时写数据库和文件存储，需要明确一致性策略。

原则：

- 数据库记录保存资源状态，文件系统只保存二进制内容。
- 上传过程中先写临时目录，成功后再移动到正式目录。
- 创建资源记录和创建处理任务应在一个数据库事务内完成。
- 派生文件生成失败时不回滚资源主记录。
- 彻底删除应走后台任务，删除失败可重试。
- 定期提供一致性检查任务，发现数据库记录和文件缺失不一致的问题。

### 12.3 备份与迁移

第一版就应考虑备份，否则资源库越大迁移越困难。

备份对象：

- PostgreSQL 数据库。
- `storage/` 文件目录。
- 环境变量和部署配置。

备份原则：

- 数据库备份和文件备份要尽量在同一时间窗口内完成。
- 文件存储路径不要写死绝对路径，方便迁移。
- 派生文件可以选择不备份，因为可从原文件重建。
- 原文件必须备份。
- 第一版应至少做一次恢复演练，验证备份可用。

### 12.4 性能目标

第一版不追求大规模并发，但需要有明确底线。

建议目标：

- 资源列表默认分页，不一次性加载全部资源。
- 资源库页面首屏加载控制在 2 秒左右。
- 图片缩略图由后端生成，不在前端加载原图当缩略图。
- 上传接口只完成保存和建任务，不等待完整处理。
- Worker 并发数默认较小，例如 2，避免本机 CPU 被视频处理打满。
- 列表搜索和筛选字段建立必要索引。

### 12.5 MVP 验收闭环

MVP 完成不以“页面数量”为准，而以资源管理闭环为准。

必须满足：

1. 用户能上传图片、视频、音频、PDF、文本和压缩包。
2. 上传后能在资源库看到资源和处理状态。
3. 图片能看到缩略图，视频能看到封面，文本/PDF 能被检索基础内容。
4. 用户能编辑标题、描述、分类、来源和许可证备注。
5. 用户能通过关键词、类型、分类筛选资源。
6. 用户能创建集合并把资源加入集合。
7. 用户能下载原文件。
8. 用户能删除到回收站、恢复、彻底删除。
9. 处理失败时能看到失败原因并重试。

## 13. MVP 开发优先级

### 13.1 第一阶段：基础框架与资源闭环

目标：完成项目骨架、上传、资源记录、列表、详情和下载。

功能：

- 项目基础框架
- Docker Compose
- 数据库 schema
- Prisma schema 和迁移
- 文件上传
- 原文件存储
- 资源列表
- 资源详情
- 下载原文件
- 删除到回收站
- 基础错误处理

验收标准：

- 能上传文件。
- 能在列表看到资源。
- 能打开详情页。
- 能下载原文件。
- 能删除和恢复资源。

### 13.2 第二阶段：异步处理与预览

目标：资源上传后能自动生成基础预览和元数据。

功能：

- Redis + BullMQ
- 独立 Worker
- 处理任务状态
- 图片缩略图
- 视频封面帧
- 视频/音频时长
- 文本内容提取
- PDF 文本提取
- 处理失败重试
- hash 去重提示

验收标准：

- 上传接口不会等待完整处理完成。
- 图片资源有缩略图。
- 视频资源有封面图。
- 音视频能显示时长。
- PDF 和文本能提取基础内容。
- 处理失败能看到原因并重试。

### 13.3 第三阶段：元数据、组织与搜索

目标：资源可被整理、归类和查找。

功能：

- 分类
- 收藏
- 关键词搜索
- 类型筛选
- 分类筛选
- 时间筛选
- 排序
- 批量分类

验收标准：

- 能按分类浏览。
- 能通过关键词、类型和分类找到资源。
- 能批量修改分类。

### 13.4 第四阶段：集合、批量操作和回收站增强

目标：提高日常整理和复用效率。

功能：

- 集合
- 集合封面
- 批量加入集合
- 批量下载
- 回收站彻底删除
- 清空回收站
- 首页统计看板

验收标准：

- 能创建集合并添加资源。
- 能批量下载集合资源。
- 能彻底删除回收站资源。
- 首页能看到资源类型统计和最近上传。

### 13.5 第五阶段：搜索和体验优化

目标：大量资源下仍然容易找到目标资源。

功能：

- PostgreSQL 全文检索优化
- 搜索结果高亮
- 最近搜索
- 处理失败任务入口
- 缩略图加载优化
- 空状态和错误状态优化

验收标准：

- 用户可以通过关键词和类型快速定位资源。
- 资源较多时列表分页、筛选和搜索仍然可用。

### 13.6 第六阶段：游戏资源专项增强

目标：增强游戏开发相关资源组织能力。

功能：

- 游戏素材类型细分
- sprite sheet 元数据
- tileset 元数据
- 音效/BGM 标记
- 引擎版本备注
- 平台备注
- 许可证状态标记

验收标准：

- 游戏资源可按角色、场景、UI、音效、BGM、tileset 等维度管理。
- 一个游戏项目可通过集合组织完整资源包。

## 14. 后续增强方向

第一版稳定后再考虑以下能力：

- 多用户和权限
- 公开分享链接
- 外部 API
- Webhook
- 第三方素材站导入
- 语义搜索
- 相似图片搜索
- OCR
- 3D 模型在线预览
- 音频波形预览
- 资源版本管理
- 资源依赖关系
- 审核工作流
- 操作审计
- MinIO/S3 对象存储
- OpenAssetIO 或创作软件集成

## 15. 第一版推荐交付物

建议第一版最终交付以下内容：

- 可运行的 Web 管理界面
- Docker Compose 部署配置
- 上传页面
- 资源库页面
- 资源详情页面
- 分类管理页面
- 集合页面
- 回收站页面
- 后台处理队列
- PostgreSQL 数据库
- Redis 队列
- 本地文件存储
- Prisma 数据库迁移
- 基础开发文档

## 16. 风险与注意事项

### 16.1 文件处理风险

视频、PDF、压缩包、Office 文档等格式复杂，处理时可能失败。需要任务状态和失败重试机制。

### 16.2 存储增长风险

图片和视频资源增长很快。需要尽早设计清晰的存储路径、缩略图策略和回收站清理策略。

### 16.3 许可证风险

资源来自不同来源时，需要记录来源、作者和许可证备注。即使第一版不做第三方 API 导入，也应在元数据中保留这些字段。

### 16.4 搜索体验风险

只靠文件名搜索会很快不够用。第一版至少应覆盖标题、描述、分类和文本内容。

### 16.5 游戏资源复杂度风险

游戏资源往往不是单文件，而是成组出现。第一版应先用集合解决组织问题，后续再做依赖、版本和引擎专项能力。

### 16.6 备份风险

资源文件和数据库必须一起备份。如果只备份数据库，文件会丢；如果只备份文件，分类、集合和元数据会丢。

### 16.7 外部命令风险

FFmpeg、Poppler 等外部工具可能处理异常文件时卡住或失败。所有外部命令都需要超时、错误捕获和任务失败记录。

## 17. 建议的 MVP 边界

为了避免第一版过大，建议 MVP 明确只做以下闭环：

1. 上传资源。
2. 自动识别资源类型。
3. 自动生成基础预览。
4. 给资源添加标题、描述和分类。
5. 在资源库中搜索和筛选。
6. 用集合组织项目资源包。
7. 下载和删除资源。

只要这个闭环稳定，项目就已经具备实际使用价值。权限、API、外部导入和 AI 能力都可以在这个基础上继续叠加。
