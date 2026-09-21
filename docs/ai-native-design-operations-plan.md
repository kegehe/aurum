# AI 原生设计运营台方案

## 1. 结论

Aurum 的样式功能应演进为一个内部使用的设计运营系统：

- 主题、布局、组件和样式包全部由系统拥有和维护。
- 运营者通过 AI 对话和结构化工具创建、调整这些设计资产。
- AI 只能生成可审查的候选变更，不能未经审核覆盖正式资产。
- 选中的候选方案发布为新的不可变版本，历史版本通过再次发布进行恢复。
- 外部 AI 默认只读，只能消费已发布的设计规范。

这不是社区投稿平台、通用截图爬虫，也不是让聊天模型直接向生产环境写任意 CSS 的界面。

## 2. 产品原则

事实来源必须是结构化设计数据，而不是截图、提示词、模型生成的 HTML 或导出的 CSS。

```text
基础规范 -> 语义主题 -> 组件配方 -> 布局配方 -> 样式包
                                                   |
                                             发布版本
                                                   |
                                  人类复制与外部 AI 只读检索
```

`StylePack` 是一个可直接使用的命名预设，引用有版本号的基础规范、主题、组件配方和布局配方，而不是复制成互不关联的文件。

截图、链接、开源设计系统、购买素材包和 AI 结果都只能作为参考。参考资料是草稿的证据，不是可以直接发布的实现来源。最终发布内容必须原创、经过校验并具备清晰溯源。

## 3. 对原方案的风险审查

AI 生成多个方案、并排比较、确认后替换、支持历史回退，这条主流程是正确的，但必须加入以下约束：

| 风险 | 设计决策 |
| --- | --- |
| AI 改坏正在使用的设计 | 正式版本不可变；AI 只能写入草稿。 |
| A/B/C 方案基准不同 | 每个候选记录唯一的 `baseVersionId`；基准过期后不能发布。 |
| 截图差异掩盖语义错误 | 结构化 Diff 是权威结果，视觉 Diff 只是辅助证据。 |
| 回退破坏历史 | 回退创建并发布新版本，不能修改或删除旧版本。 |
| 主题修改静默影响其他样式包 | 依赖固定到具体版本；升级必须生成迁移提案。 |
| 模型输出任意 CSS/HTML | 使用受限领域 Patch，不接受原始模型代码作为正式数据。 |
| AI 读取整个库或恶意网页 | 检索有范围和大小限制；网页内容只能作为不可信数据。 |
| 多方案成本过高 | 先生成短计划，默认最多三个候选；只渲染需要预览的候选。 |

## 4. 范围与非目标

### 4.1 本方案包含

- 系统自有的基础规范、主题、组件配方、布局配方和样式包。
- 通过自然语言和 AI 工具进行设计调整。
- 草稿、多候选方案、Diff、预览快照、质量校验、发布、历史、恢复和审计。
- 图片参考和经过来源策略批准的 URL 参考分析。
- 面向人的复制/导出，以及面向其他 AI 的只读检索。

### 4.2 第一版不做

- 用户投稿、公共社区内容、多租户工作区和公开写入 API。
- 任意网站克隆、抓取页面源码，或从截图/链接自动发布。
- AI 直接修改正式版本。
- 对任意网站进行浏览器自动化；动态页面采集属于后续隔离 Worker。
- 在规范模型稳定前做 Figma 双向同步、完整组件代码生成和向量检索。

## 5. 规范数据模型

这些模型应与通用 `Resource` 分开；现有资源和溯源记录可以保存参考图片、文档和 URL。

### 5.1 设计文档

`DesignDocument`

- `id`、`slug`、`name`、`kind`：`foundation | theme | component | layout | style_pack`。
- `status`：`draft | published | deprecated | archived`。
- `currentPublishedVersionId`、`visibility`（第一版为 `internal`）。

`DesignVersion`

- `id`、`documentId`、`versionNumber`、`baseVersionId`。
- `content`：通过 Schema 校验的规范 JSON。
- `contentHash`：不可变内容校验和去重。
- `summary`、`changeKind`：`create | update | restore | dependency_upgrade`。
- `publishedAt`、`createdAt`、`referenceSnapshotIds`、`validationRunIds`。

Token 内容应采用兼容 DTCG 的 JSON，包含 `$type`、`$value`、分组和别名引用。CSS、Tailwind、HTML 和 Markdown 都是派生导出物，而不是事实来源。DTCG 用于跨工具交换设计 Token：https://www.designtokens.org/TR/2025.10/format/

### 5.2 草稿与候选

`ChangeSession` 表示一次 AI 调整请求及范围，保存原始请求、参考资料、AI 供应商/模型标识和检索上下文快照。聊天文本不是设计规范的事实来源。

`DesignDraft` 拥有一个或多个版本的工作副本，具有乐观锁版本号和过期时间，只能在内部编辑器中使用。

`CandidateProposal` 保存 `draftId`、`baseVersionId`、标签、理由、`patch`、`structuredDiff`、`impactReport` 和状态。状态为：

```text
planned -> generated -> rendered -> validated -> selected | rejected | expired
```

`ValidationRun` 和 `PreviewSnapshot` 保存确定性的校验结果与预览产物，历史比较不能依赖变化中的运行时数据。

### 5.3 依赖版本

`StylePackVersion` 必须引用具体的主题、组件和布局版本。共享主题更新不能静默改变已发布样式包；否则历史比较和回退都会失去意义。

这里的 `StylePackVersion` 不是另一套版本体系，而是 `DesignDocument.kind = style_pack` 对应的 `DesignVersion`。如果为了查询性能建立独立投影表，也必须以 `DesignVersion` 为唯一事实来源，不能让两套版本号分别演进。

### 5.4 变更集合与参考快照

- `ChangeSet` 是一次可发布的跨文档变更集合，记录文档 ID、基准版本、候选 Patch、依赖变化和发布事务 ID。它解决主题、组件和布局必须一起发布的问题。
- `ReferenceSnapshot` 是某次分析实际使用的参考快照，记录来源 ID、内容哈希、采集时间、使用策略、快照版本和保存期限。它不能等同于当前仍可访问的 URL。
- `DesignVersion.referenceSnapshotIds` 和 `ChangeSession` 都只能引用这些不可变快照，不能引用会变化的网页内容。

## 6. AI 变更工作流

### 6.1 状态机

```text
正式版本 v12
  -> 变更会话 -> 从 v12 创建草稿 -> 候选 A/B/C
  -> 渲染与校验 -> 选择候选 -> 发布 v13
  -> 以后可将 v12 内容恢复为新的 v14
```

任何操作都不能修改已发布的 `v12`、`v13` 或其他版本。

### 6.2 工具契约

模型不得获得数据库凭据、文件系统、任意 SQL 或任意网络访问能力。服务端提供受限工具：

读取：

- `search_design_assets(query, filters)`
- `get_design_document(documentId, versionId)`
- `get_dependency_graph(documentId, versionId)`
- `get_reference(referenceId)`
- `get_validation_policy(scope)`

草稿：

- `create_draft(baseVersions)`
- `propose_change_plan(draftId, intent)`
- `create_candidate(draftId, plan)`
- `apply_domain_patch(candidateId, patch)`
- `render_candidate(candidateId, viewports)`
- `validate_candidate(candidateId)`
- `compare_candidate(candidateId, baseVersionId)`
- `select_candidate(candidateId)`
- `publish_selected_candidate(draftId, expectedBaseVersions)`

写入工具必须同时校验基准版本和领域 Schema。`apply_domain_patch` 只接受替换语义 Token、调整已知组件变体、修改声明过的栅格规则等操作，拒绝任意 HTML、JavaScript、远程资源、未知路径和文件写入。

### 6.3 示例

请求：“把运营后台改得更专业、偏蓝灰色，但不要降低表格密度和文字可读性。”

流程应为：

1. 只读取选中的主题、数据表格、后台布局、固定依赖和校验策略。
2. 生成短计划和最多三个有边界的方向。
3. 修改 `color.action.primary`、`surface.sidebar`、`border.subtle` 等语义 Token，保持表格间距不变。
4. 按固定视口渲染，执行对比度、焦点态、溢出和布局检查。
5. 并排显示候选，允许全量或按 Patch 分组接受。
6. 只有候选被选择且校验允许发布时，才生成新正式版本。

## 7. 审查界面

主界面应是“对话 + 画布 + 检查器”，不能只有聊天窗口：

```text
左侧：AI 对话、变更计划、候选 A/B/C
中间：基准与候选预览、视口切换、视觉 Diff
右侧：结构化 Diff、依赖影响、校验、Patch 分组选择
```

### 7.1 比较模式

1. **结构化 Diff（权威）**：Token、组件属性、布局规则、引用和版本。
2. **渲染比较**：固定桌面、平板和手机视口的并排快照。
3. **视觉/像素 Diff（辅助）**：标出变化区域，允许字体和抗锯齿噪声。
4. **影响报告**：受影响的样式包、模板、生成物和破坏性变更。
5. **质量报告**：可访问性、响应式、导出和来源策略状态。

预览必须使用固定示例数据、浏览器/运行时、视口和字体状态，否则视觉 Diff 不能作为发布依据。

### 7.2 候选和局部接受

- 单次请求默认最多三个候选。
- 每个候选必须说明目标、取舍和校验状态。
- 支持接受配色而拒绝布局等 Patch 分组操作。
- 局部接受后创建派生候选并重新校验，不能继承父候选的通过状态。
- 基准版本过期后，候选自动失效。

## 8. 发布校验门禁

阻断性检查必须全部通过；例外必须记录明确的人工覆盖原因。

| 门禁 | 检查内容 |
| --- | --- |
| Schema | Token 类型、别名、布局和组件属性均合法。 |
| 依赖 | 固定版本存在，无不兼容或循环依赖。 |
| 可访问性 | 对比度、焦点可见性和交互状态；以 WCAG 2.2 为基线：https://www.w3.org/TR/WCAG22/ |
| 响应式 | 无溢出、重叠、不可操作控件或缺失主要操作。 |
| 导出 | DTCG JSON、CSS、Tailwind、Markdown 均成功。 |
| 代码安全 | 无脚本、事件属性、任意远程资源或不安全 URL。 |
| 溯源 | 关联参考具备来源策略和使用状态。 |

AI 生成的说明、CSS 和 HTML 只能作为非权威辅助信息。生产导出必须从规范数据生成，并在服务端清洗预览产物；iframe sandbox 不是发布安全边界。

## 9. 恢复、历史与审计

界面称为“回退”，数据库操作必须是创建新版本：

```text
v12 -> v13 -> 恢复 v12 内容 -> v14
```

`v14` 记录 `baseVersionId = v13` 和 `restoredFromVersionId = v12`。历史至少包含版本号、摘要、操作人、发布时间、父版本、恢复来源、候选 Patch、校验结果、参考 ID/哈希、AI 模型标识、依赖变化和导出物哈希。

不得在审计记录中保存上游 AI API Key、Cookie、URL 凭据或无限量原始网页内容。

## 10. 图片和 URL 参考

### 10.1 使用状态

- `original`：系统原创素材或代码。
- `licensed_reuse`：明确授权允许目标范围内复用。
- `inspiration_only`：允许视觉分析，不复制源码，不声称拥有原作。
- `blocked`：禁止分析或保留。

系统从参考特征生成原创草稿，不能把结果标记为第三方品牌复制品，也不能把抓取源码导出为系统自有组件。

### 10.2 图片

图片适合分析色板、对比度、密度、层级、留白、形状语言和大致构图，但不能可靠确定字体、隐藏状态、响应式行为、可访问性和权利。AI 结果先标记为观察/假设，转成规范后再人工确认。

现有样式分析模块可以作为 `analyze_reference` 起点：它能确定性提取色板、AI 不可用时本地降级并生成结构化档案。但结果目前是一次性的，应写入 `ChangeSession` 和 `DesignDraft`，不能直接发布。

### 10.3 URL

现有链接导入链路适合第一阶段元数据处理：canonical URL、标题、Open Graph 和预览图。它已经有 HTTP(S) 限制、重定向限制、DNS/IP 校验、响应大小限制和超时控制。

设计参考分析按以下阶段执行：

1. 规范化并校验 URL。
2. 要求来源策略启用：域名白名单、条款 URL、robots URL、速率/并发限制和使用状态。
3. 先采集有大小限制的元数据；标题、DOM、alt 文本和图片文字均是不可信数据。
4. 只有策略允许时才保存参考快照或操作员截图进行视觉分析。
5. 根据观察生成草稿，不能抓取源码或自动发布派生内容。
6. 动态页面需要隔离 Worker，且只允许批准的域名和策略。

Robots Exclusion Protocol：https://www.rfc-editor.org/rfc/rfc9309.html。它不等于版权或合同授权，仍需检查来源条款。服务端抓取应遵循 SSRF 防护：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 10.4 提示词注入

网页、图片和导入文本都是不可信输入。AI 策略必须明确：参考内容不能授权工具调用、修改安全策略、泄露秘密或覆盖设计范围。工具调用只能来自经过校验的应用状态，不能由页面中的指令触发。

## 11. 外部 AI 消费

内部编辑与外部消费使用同一个设计目录，但权限不同：

- 内部助手：读取、创建草稿、生成候选、渲染、校验、选择和发布。
- 外部 AI：只能读取已发布版本，只开放检索、读取和导出。

未来 MCP Server 可以提供 `search_design_assets`、`get_style_pack`、`get_tokens`、`get_layout_recipe` 等只读工具。MCP 适合作为模型工具协议，但不能向外部 AI 暴露写操作：https://modelcontextprotocol.io/specification/2025-06-18/server/tools

官方目录较小时，结构化筛选和全文搜索足够。只有证明它们无法满足意图查询后才考虑向量检索。检索先返回摘要，选中后再读取完整版本，避免占满上下文。

## 12. 当前项目的复用与缺口

可以复用：

- `apps/api/src/modules/style`：图片分析、本地降级、结构化档案、变体、CSS Token 和风格说明导出。
- `apps/api/src/modules/ai-settings`：运行时 AI 配置。
- `apps/api/src/modules/ingestion`、`apps/api/src/common/security/safe-url.service.ts`：异步链接、溯源、来源策略和 SSRF 感知抓取。
- `apps/web/src/app/(dashboard)/style-lab`：参考分析与导出原型。

缺口：

1. 没有设计文档、草稿、候选、版本、依赖、预览和校验模型。
2. 样式分析结果没有绑定草稿和来源策略并持久化。
3. CSS 目前是便利导出，不是 DTCG 规范源。
4. 没有领域 Patch、乐观并发控制和发布门禁。
5. 链接连接器面向元数据，还不是设计参考流程。
6. 当前应用缺少完整应用级认证和限流；没有服务认证、授权和审计前，不能把编辑工具或 MCP Server 暴露到内部边界之外。

## 13. 交付顺序

### 阶段一：规范数据与人工发布

- 新增设计文档、版本、依赖模型和迁移。
- 定义 DTCG Token 数据以及组件/布局 Schema。
- 建立小规模目录：5 个基础主题、15 个布局配方、20 个组件配方、12 个样式包。
- 完成版本历史、依赖图、导出和人工发布。

### 阶段二：AI 草稿与候选

- 新增变更会话、草稿、候选、受限 Patch、乐观锁和审计。
- 实现结构化比较和预览快照。
- 增加校验门禁；局部接受后重新校验。
- 将现有样式分析接口接入创建草稿工具。

### 阶段三：参考治理

- 新增 `StyleReference`、使用状态、来源策略和审核视图。
- 通过现有安全连接器支持图片参考和仅元数据 URL 参考。
- 仅针对批准域名增加隔离渲染 Worker。

### 阶段四：只读 AI 接入

- 增加服务认证和审计。
- 通过受限内部 REST API 和只读 MCP Server 暴露已发布版本。
- 先建立检索评测用例，再决定是否增加向量检索。

## 14. 第一版验收标准

- 操作员可从已发布的主题、组件、布局或样式包创建草稿。
- AI 可针对同一基准版本生成最多三个候选 Patch。
- 界面展示结构化 Diff、固定视口预览、影响报告和校验状态。
- 选择候选后生成不可变新版本，不覆盖旧版本。
- 恢复历史版本生成新版本并保留完整历史链路。
- 基准过期或校验失败的候选不能发布。
- 图片分析只能创建草稿，不能直接发布。
- URL 分析遵循元数据优先和来源策略，并使用现有 URL 安全层。
- 所有导出从规范数据生成，外部 AI 只能检索已发布资产。

## 15. 二次评审：必须补充的工程约束

前面的产品方向成立，但在真正开发前还需要明确以下事项。它们不是可选的优化，而是保证“多方案对比、确认发布、历史恢复”可靠运行的基础。

### 15.1 多文档变更必须原子发布

一个样式包通常同时引用主题、组件和布局。AI 可能一次修改多个文档，因此不能分别发布三个版本，否则会出现主题已更新、组件仍是旧版的半成品状态。

- `ChangeSet` 必须声明本次变更涉及的全部文档和基准版本。
- 选择候选后，要在一个数据库事务中创建所有新版本并更新 `currentPublishedVersionId`。
- 任意一个文档校验失败，整个发布事务回滚。
- `StylePackVersion` 必须记录完整依赖清单和依赖内容哈希，方便复现和审计。

### 15.2 并发与过期状态需要落到数据模型

仅写“乐观锁”还不够，需要明确状态和数据库约束：

- 每个文档的版本号必须唯一，发布更新必须带 `expectedCurrentVersion` 条件。
- 当前正式版本发生变化后，草稿和候选进入 `stale`，不能静默重新基于新版本套用旧 Patch。
- 冲突解决应生成新的候选方案并重新校验，而不是自动合并 Token 或布局规则。
- 发布接口必须幂等，重复提交不能产生两个相同的正式版本。

### 15.3 AI 生成、渲染和校验不能全部放在请求线程

现有 `StyleService` 是同步、一次性返回的图片分析服务，适合实验室，不适合多候选设计发布。未来的候选生成、浏览器渲染和多视口校验可能耗时、失败或产生 AI 费用，应使用任务记录：

- 创建请求只返回 `changeSessionId` 或任务 ID。
- 任务具备 `pending | running | succeeded | failed | canceled` 状态、进度、重试次数、错误码和取消能力。
- AI 调用、预览渲染、校验应可分别重试；不能因为渲染失败而重复扣 AI 费用。
- 为单次会话设置候选数量、图片大小、渲染视口、耗时和 Token/费用上限。

### 15.4 预览必须使用受控的组件渲染器

当前样式实验室允许模型返回自包含 HTML，并在前端 iframe 中预览。正式设计运营台不应把这种 HTML 作为组件事实来源：

- 组件预览应从已注册的组件类型、Token 和示例数据渲染。
- 模型返回的 HTML/CSS 只能作为草稿参考，服务端必须再次清洗并禁止脚本、事件属性、外部字体、图片和网络请求。
- 预览 Worker 应使用固定浏览器版本、字体白名单、无外网权限和独立临时目录。
- `PreviewSnapshot` 需保存浏览器版本、Fixture 版本、视口、字体清单、产物哈希和生成时间，否则历史视觉 Diff 无法复现。

### 15.5 DTCG 需要版本策略，不能直接把预览草案当稳定标准

当前引用的 DTCG 2025.10 页面仍标注为预览草案。因此应在产品内定义“内部规范版本”：

- 固定采用一个经过验证的 DTCG 子集，并记录 `tokenSchemaVersion`。
- 不支持的 DTCG 特性必须明确拒绝或转换，不能静默丢字段。
- 未来升级 DTCG 时，以迁移脚本和新 Schema 迁移版本，而不是直接改变历史 Token 的解释方式。
- CSS、Tailwind 等导出器都要针对 `tokenSchemaVersion` 测试。

### 15.6 URL 来源策略必须真正执行，而不只是记录 URL

现有链接连接器主要解析 canonical、标题和 Open Graph 元数据，不能据此声称已经完成设计参考治理。正式实现还需要：

- 对规范化后的最终域名重新执行来源白名单检查；每次重定向都要检查。
- 明确 `robots.txt` 是自动访问规则，必须实际抓取、解析并缓存结果；它不是版权或商用授权。
- `og:image`、favicon 等派生 URL 在后续下载时必须再次经过 SSRF、域名策略、MIME 和大小限制。
- 来源策略要记录允许的动作：`metadata_only | operator_screenshot | render_snapshot | mirror_file`，默认只允许前两项。
- 设计参考的网页文本、DOM、图片 OCR 和模型摘要应设置保存期限，避免无限积累第三方内容。

### 15.7 现有 AI 模块还不是通用设计代理

当前 AI 能力集中在图片风格分析和变体生成，尚未提供“读取目录、规划变更、调用工具、处理工具结果、生成领域 Patch”的通用代理层。实现时需要单独抽象：

- `DesignAgent`：负责会话、上下文预算、工具选择和模型无关的编排。
- `DesignToolGateway`：负责鉴权、范围校验、幂等、审计和工具结果裁剪。
- `PatchValidator`：负责领域 Patch Schema、路径白名单、依赖检查和冲突检测。
- 现有 `StyleService` 作为 `analyze_reference` 能力接入，不应直接承担发布、版本和对话编排。

### 15.8 StyleProfile 到正式资产需要明确映射和人工确认

现有 `StyleProfile` 包含色板、字体、间距、布局、质感和 HTML 变体，但它不等于正式的 Theme、Component 或 Layout。需要定义转换规则：

- 颜色先映射为原始色阶，再映射为语义 Token；不能直接把 `primary` 当作所有操作色。
- 字体、间距和圆角必须经过可用性、字体授权和 Token Schema 校验。
- `variations[].html` 只能作为构图参考，不能自动变成正式组件。
- AI 推断的布局区域、断点和交互状态都要标记置信度，并由操作员确认后才进入发布候选。
- 草稿应保留原始分析结果、转换后的规范和人工修改差异，方便追溯模型误判。

### 15.9 发布与外部消费还需要响应契约

只读 REST/MCP 不应直接返回巨大的完整文档。应定义稳定的消费格式：

- 搜索先返回 `id`、`slug`、版本、摘要、适用场景、标签和校验状态。
- 详情返回固定的 `schemaVersion`、依赖版本、Token、组件/布局规则和导出链接。
- 默认不返回原始参考图片、网页 HTML 或未发布草稿。
- 使用服务 API Key、限流、分页、最大响应大小和调用审计。
- 外部 AI 请求必须显式指定 `published` 版本或允许的版本范围，不能默认读取“当前草稿”。

## 16. 已实施的运行约束（2026-08）

- 预览由受控 Playwright Chromium Fixture 生成，固定桌面、平板、移动端视口；浏览器页面拦截全部网络请求，只消费已校验的结构化设计 JSON。候选截图、像素 Diff、产物哈希与 Fixture/浏览器标识均会持久化。
- 运营台同时展示结构化 Diff 与三端 PNG/像素 Diff。预览图片只能通过候选和视口定位，不接受任意存储路径；任务取消与任务完成使用状态条件更新，取消成功后不会把候选回写成已校验。
- URL 参考必须绑定启用的来源登记项，来源必须配置 `baseUrl` 且允许 `link_only` 或 `metadata_only`。每次跳转均重做来源范围与 SSRF 校验；系统实际读取并解析同源 `robots.txt`，不允许时直接拒绝。
- URL 参考只保留标题、描述、发布者、规范 URL、图片 URL 等有限元数据，策略固定为 `inspiration_only`，默认保留 30 天；不持久化 DOM、样式表、脚本或网页正文，也不会将它们提供给设计生成模型。
- 面向外部 AI 的已发布资产 REST/MCP 在生产环境要求 `DESIGN_READ_API_KEY`，并记录密钥指纹、客户端标识和访问端点。该密钥是服务接入控制，不替代应用级身份认证；内部编辑接口应在部署时置于现有的受信网络和身份认证边界之后。

### 16.1 生产加固补充

- 生产环境中，所有设计编辑、草稿、候选、任务和预览接口都要求 `DESIGN_INTERNAL_API_KEY`；密钥仅由已认证的反向代理或服务网关注入 `x-aurum-design-internal-key`，绝不能交给浏览器。运营台通过 Next 服务端 `/api/design-proxy` 转发，代理同时要求受信网关注入 `x-aurum-design-dashboard-key`（值为 `DESIGN_DASHBOARD_PROXY_KEY`，网关必须在认证后覆盖并剥离客户端同名 Header），再由服务端注入内部密钥。未配置这两个密钥时生产代理拒绝请求。已发布 REST/MCP 继续使用独立的 `DESIGN_READ_API_KEY`。
- Token 值采用类型白名单，并拒绝 CSS 分号、规则括号、远程 URL、`@import` 与脚本模式；CSS 导出只包含已验证的标量 Token。
- 多文档发布以 `ChangeSetDraft` 的草稿全局唯一成员关系约束。加入两个及以上草稿的 ChangeSet 后，单草稿发布会被拒绝，只有整体事务能发布。
- 设计任务有租约、心跳和超时回收；候选生成在模型返回、逐个候选写入和完成时都复核租约，取消不会再覆盖为成功。
- 受控渲染器按 Token、组件、布局和样式包分别使用注册 Fixture，并将完整安全 JSON 映射到确定性画面；不再把组件或样式包变更渲染成相同的通用页面。
- URL 参考按来源速率限制并缓存 robots 规则。存在 `termsUrl` 时，来源 `config` 必须记录 `designReferenceTermsAcceptedAt` 与 `designReferenceTermsAcceptedBy`；`requiresReview` 来源创建待审核草稿，须调用审核接口后才可继续编辑。过期参考快照每小时清理。
