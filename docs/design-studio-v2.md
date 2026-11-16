# 设计工作室 v2：资产库 + 工作台 + AI 接入

> 本文是 docs/ai-native-design-operations-plan.md 的产品层修订版。
> 默认前提：内部自用 / 小团队使用，产出主要贴回 Next.js + Tailwind 项目。
> 如果实际是多用户平台或需要兼容任意技术栈，第 3、11 节要加一层兼容设计，但整体方向不变。

## 1. 结论

把现有「样式实验室 + 创建向导 + 审核台」重构成三个面：

1. **资产库**：默认首页。按样式 / 组件 / 动效 / 布局分 tab，直接看效果、搜索、复制、给 AI 用。
2. **工作台**：画布优先。选中元素 → AI 只改选中范围 → 实时预览 → 保存入库。
3. **AI 接入**：每个资产自带 usage manifest、registry 导出和 MCP 入口。

核心变化：

- 资产不再是受限 JSON，而是「代码包 + manifest + 预览快照 + AI 用法」。
- Token/主题仍然结构化，负责换肤和一致性；组件/布局/动效以代码为事实来源。
- 保存即入库；发布只是「标记可用」。候选/审核降为高级能力，不再挡在主流程上。
- 预览与快照使用同一份代码，不再出现「工作台看到 A、审核台看到 B」。
- 图片参考按区域解析，产出按钮/卡片/布局/动效的草稿，而不是一整张风格档案。

先做一条垂直切片：**图片里的按钮 → 工作台调整 → 存入按钮库 → 复制 React/Tailwind/CSS → 复制给 AI**。跑通后再复制到卡片、文字、动效、布局。

### 1.1 v1 明确不做

- 自由拖拽 / 绝对定位的布局编辑器（v1 用 slots + 断点）。
- 多人协作、评论、细粒度权限（先按内部单用户/小团队）。
- URL 页面截图、DOM 抓取、浏览器自动化（只保留元数据链路）。
- 字体文件、图片资产管理（v1 用系统字体和 data URI/占位图）。
- 任意框架、任意 JS 运行时（只支持 React + Tailwind 白名单）。
- Dialog / Dropdown / Tabs 等复杂交互组件（v1 先做按钮/卡片/文字/布局；复杂组件放 v2）。
- Framer Motion / GSAP 等 JS 动画库（v1 动效只用 CSS keyframes/transitions）。
- 复杂关键帧/时间轴编辑器（v1 只做 duration/easing/delay + 重播）。
- Figma/Sketch 导入、向量检索、相似图搜索。

## 2. 为什么不是 v1

v1 的四个隐含假设不成立：

| 假设 | 现实 | v2 决策 |
| --- | --- | --- |
| 结构化 JSON 能表达按钮/布局/动效 | 布局 schema 只有 layoutType + regions；复杂效果会被 CSS 白名单挡住 | 双轨：Token 结构化，组件/布局/动效代码化 |
| 发布/审核是主流程 | 创作工具的主流程是改 → 看 → 存 | 保存即入库；审核台降为历史/高级功能 |
| 聊天是主交互 | 用户真正要的是「改这个按钮」 | 画布选中 + 局部指令；聊天是辅助 |
| 库可以最后做 | 没有资产格式和快照，库只能做成文字列表 | 先定资产包，再做库 |

保留 v1 的地基：

- DesignDocument / DesignVersion / DesignDraft / CandidateProposal 的版本模型。
- Token 校验、对比度门禁、CSS 导出、Tailwind token 导出。
- Playwright 受控渲染、预览快照、任务租约与重试。
- 已发布资产的只读检索、ai-tools、MCP 入口。
- 图片分析、AI 设置、存储服务、内部守卫。

下线或降级：

- /style-lab 独立页面：合并为工作台的「从图片开始」。
- /design-library 创建向导：由工作台取代。
- /design-library/review 审核台：移到资产详情的历史/高级入口。
- 以 fixture JSON 作为权威预览：组件/布局改为真实代码预览。

## 3. 资产模型

### 3.1 双轨

| 类型 | 事实来源 | 适用 kind | 预览 |
| --- | --- | --- | --- |
| Token 资产 | 结构化 Token JSON | theme / foundation / style_pack | 色板 + 组件示例 |
| 代码资产 | 源码文件 + manifest | component / layout / animation | 真实代码渲染 |

style_pack 只引用具体版本的 theme/component/layout，不复制内容。

### 3.2 资产包目录

    asset/
      manifest.json          # 元数据、文件清单、AI 用法
      files/
        button-glass.tsx     # 事实来源
        button-glass.css     # 可选，作用域样式
      preview/
        preview.tsx          # 预览入口，使用 fixture
        fixture.tsx          # 示例数据 / slot 填充
      tokens.json            # 可选，资产用到的 token 快照
      README.md              # 人读说明（生成）
      ai.md                  # AI 用法（生成）
      registry.json          # 导出物，不参与版本内容

所有包内文件（含 preview/fixture/ai.md/README）都存在 DesignAssetFile；manifest.files 只列「可交付/可安装」的文件，preview/fixture 是内部预览文件，不随复制导出。

### 3.3 manifest 示例（按钮）

    {
      "schemaVersion": "aurum.asset.v1",
      "id": "asset_01J...",
      "slug": "glass-button",
      "name": "玻璃按钮",
      "kind": "component",
      "subtype": "button",
      "description": "半透明玻璃质感的主操作按钮，适合深色或图片背景。",
      "whenToUse": "需要悬浮在图片/渐变背景上的主操作；不适合大面积表单。",
      "tags": ["glass", "dark", "primary"],
      "source": "reference",
      "provenance": {
        "type": "inspiration_only",
        "referenceAnalysisId": "ref_01J...",
        "note": "基于用户提供的参考图重新实现，未复制源码。"
      },
      "framework": "react",
      "styling": "tailwind",
      "runtime": { "react": "19", "tailwind": "4" },
      "dependencies": ["clsx"],
      "registryDependencies": [],
      "assetDependencies": [
        { "slug": "midnight-theme", "version": 3 }
      ],
      "tokens": ["color.primary", "color.surface", "radius.md", "shadow.glass"],
      "parts": [
        { "id": "root", "name": "按钮", "selector": "[data-part=root]" },
        { "id": "label", "name": "文字", "selector": "[data-part=label]" }
      ],
      "props": [
        { "name": "variant", "type": "primary | ghost", "default": "primary" },
        { "name": "size", "type": "sm | md", "default": "md" }
      ],
      "states": ["default", "hover", "active", "focus-visible", "disabled"],
      "viewports": ["mobile", "tablet", "desktop"],
      "files": [
        {
          "path": "files/button-glass.tsx",
          "target": "components/ui/glass-button.tsx",
          "type": "registry:ui",
          "language": "tsx"
        },
        {
          "path": "files/button-glass.css",
          "target": "components/ui/glass-button.css",
          "type": "registry:file",
          "language": "css"
        }
      ],
      "preview": {
        "entry": "preview/preview.tsx",
        "fixture": "preview/fixture.tsx"
      },
      "ai": {
        "summary": "玻璃拟态主按钮，强调半透明、内高光和细边框。",
        "usage": "在深色背景或图片上作为主 CTA；通过 variant 切换主/次样式。",
        "examples": ["用 GlassButton 包裹主操作文字"],
        "antiPatterns": ["不要放在纯白大段文字中，会失去层次"]
      }
    }

### 3.4 字段约束

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| schemaVersion | 是 | 固定 aurum.asset.v1 |
| kind | 是 | component / layout / animation / theme / foundation / style_pack |
| subtype | 否 | 用于筛选 |
| source | 是 | manual / ai / reference / recipe / import |
| tokens | 否 | 引用到的 Token 路径，保存时校验存在性 |
| assetDependencies | 否 | 钉住内部主题/组件/布局的 slug + 版本；布局与样式包必填 |
| runtime | 否 | React / Tailwind 主版本；缺省按当前工作台版本 |
| tokenMap | 否 | 导出时把 --aurum-* 映射到宿主主题变量 |
| parts | 否 | 可选中、可对话的元素范围；预览会注入 data-part |
| states | 否 | 交互组件必须覆盖 hover / focus-visible / disabled |
| files | 代码资产必填 | 源码清单；路径不能越出资产包 |
| preview.entry | 代码资产必填 | 预览入口文件 |
| ai | 是 | 没有 AI 用法的资产不算完成 |

### 3.5 代码约束

- 只允许 React + TypeScript + Tailwind；可选 clsx / class-variance-authority / tailwind-merge / lucide-react。
- 需要 hooks/事件的组件在文件顶部写 "use client"；纯展示组件可不写。
- 禁止动态拼接 Tailwind 类名（例如 bg-[${color}]）；类名必须静态可扫描，或写进 safelist。预览编译和复制导出必须使用同一份 Tailwind source/safelist。
- 禁止使用宿主项目别名（@/...）；组件内部用相对导入，跨资产依赖用 assetDependencies / registryDependencies。
- 不要依赖宿主项目的 cn() helper；资产包内自带 lib/cn.ts，或只用 clsx + tailwind-merge，并在依赖里声明。
- 禁止网络请求、eval、new Function、动态 import()、dangerouslySetInnerHTML、外部字体和图片。
- CSS/TSX 扫描还要拒绝 url( 外部地址、http(s)://、@import、data:text/html；只允许 data:image 的内联占位图。
- v1 字体只允许系统字体栈或已声明的 Token；字体文件上传、授权和打包放 v2。图片只允许 data URI/占位图，资产图片管理放 v2。
- CSS 必须作用域化到 .aurum-<slug>，禁止全局选择器和 @import。
- 文件路径、导入路径、Token 路径都做白名单校验。
- 保存前必须通过：esbuild 语法解析、导入扫描、CSS 解析、禁用模式扫描、预览渲染。
- 预览失败不允许保存为已发布；可以保存为草稿并显示失败原因。
- preview.tsx 必须 import files 里的实际组件，不能复制一份实现；保存时校验 import 图，避免预览和复制代码不一致。
- dependencies 只表示 npm 包；内部主题/组件/布局依赖用 assetDependencies，两者不要混用。
- Tailwind utilities 本身是全局类名；v1 只要求自定义 CSS 作用域到 .aurum-<slug>，复制到宿主项目时依赖宿主 Tailwind 版本。
- contentHash 不包含 id、createdAt、preview 路径等易变字段；只哈希 manifest 语义内容 + 影响预览/交付的源码与 preview/fixture。
- 生成的 ai.md / README 不进 contentHash，避免文档格式微调就制造新版本。

### 3.6 布局资产

布局不追求自由拖拽，v1 用「slots + 栅格 + 断点」：

    {
      "kind": "layout",
      "subtype": "section",
      "layout": {
        "slots": [
          { "id": "header", "name": "页头", "required": true },
          { "id": "content", "name": "内容", "required": true },
          { "id": "aside", "name": "侧栏", "required": false }
        ],
        "breakpoints": { "mobile": 0, "tablet": 768, "desktop": 1280 },
        "grid": {
          "desktop": "12 columns / 24px gap",
          "tablet": "8 columns / 20px gap",
          "mobile": "1 column / 16px gap"
        }
      }
    }

预览 fixture 用真实组件填充 slot；复制出去的是页面级 React 代码。
slot 选择器实际修改 fixture 的 import 和 slot 内容；保存时把用到的组件写入 assetDependencies。
自由拖拽和绝对定位编辑放到 v2，不在第一版。

### 3.7 动效资产

    {
      "kind": "animation",
      "subtype": "enter",
      "motion": {
        "trigger": "on-enter",
        "duration": "240ms",
        "easing": "cubic-bezier(.22,1,.36,1)",
        "reducedMotion": "fade-only",
        "targets": ["root"]
      }
    }

必须声明 reducedMotion，否则不能发布。预览支持重播和时间轴拖动。

### 3.8 Registry 兼容

导出 registry.json 遵循 shadcn registry item 结构：

    {
      "name": "glass-button",
      "type": "registry:ui",
      "dependencies": ["clsx"],
      "registryDependencies": [],
      "files": [
        {
          "path": "components/ui/glass-button.tsx",
          "content": "...",
          "type": "registry:ui"
        }
      ],
      "cssVars": {
        "theme": {
          "radius-md": "10px"
        }
      }
    }

这样人可以直接 npx shadcn@latest add <url>，AI 也能读同一份 JSON。
Registry 是导出物，不是版本事实来源；事实来源仍是 manifest + files。

### 3.9 AI 用法清单

保存时生成 ai.md，至少包含：

- 什么时候用 / 什么时候不要用。
- 安装命令和依赖。
- Props / variants / states。
- 一段最小示例。
- 依赖的 Token 和主题。
- 常见错误。

全库生成 llms.txt，列出资产名称、slug、一句话用途和详情链接。

### 3.10 Token 注入与版本钉住

- 预览根节点注入主题 CSS 变量：.aurum-preview { --aurum-color-primary: ...; --aurum-radius-md: ... }。
- 导出默认用 --aurum-* 前缀，避免和宿主项目的 --color-primary / --radius-md 冲突；需要接宿主主题时，manifest 提供可选 tokenMap。
- Tailwind 4 通过 @theme 把 --color-primary 映射到 var(--aurum-color-primary)，组件只写 bg-primary / rounded-md 这类语义类。
- 主题可包含 light / dark 两组 Token；预览用 data-theme 切换，没有 dark 组时回退 light。复制 CSS 时两组都带上。
- 代码资产只通过 CSS 变量或 Tailwind 映射使用 Token，不写死颜色/圆角。
- 发布版本记录 assetDependencies（slug + versionId）；manifest 里写 slug + version，保存时解析成 versionId，依赖升级不自动改变旧版本。
- 预览/保存时把 assetDependencies 解析成本地包路径；资产里不要写远程 URL 或宿主别名。
- 布局引用组件、样式包引用主题/组件/布局时，都必须钉版本；换版本走「升级依赖」并生成新版本。
- 复制 React 时附带最小 theme.css；如果消费方已有主题，可只复制组件文件。

## 4. 信息架构

### 4.1 一级导航

    创作
      资产库        /library
      工作台        /studio
    交付
      AI 接入       /ai-access

资源、上传、任务中心、来源管理、系统设置保持不变。
「样式实验室」「设计运营台」从一级导航移除。

资产库是「设计区」的默认落地页，不改变全局 /dashboard 首页；从侧边栏进入创作时落到 /library。

### 4.2 路由

    /library                         资产库首页
    /library/[slug]                  资产详情
    /library/[slug]/history          版本历史
    /studio                          工作台首页（最近会话 / 新建）
    /studio/new                      新建资产
    /studio/[sessionId]              工作台会话
    /studio/reference/[analysisId]   参考分析结果
    /ai-access                       AI 接入说明

兼容跳转：

    /style-lab                  -> /studio/new?mode=reference
    /design-library             -> /studio/new
    /design-library/review      -> /library?status=draft

### 4.3 资产库 tab

| tab | 包含 kind | 说明 |
| --- | --- | --- |
| 样式 | theme / foundation / style_pack | 配色、Token、整套样式 |
| 组件 | component | 按钮、卡片、文字、输入框、导航等 |
| 动效 | animation | 进场、悬停、持续动画 |
| 布局 | layout | 页面、区块、应用壳 |

组件内部用 subtype 筛选：button / card / text / input / badge / nav / other。
其余维度用标签、来源、状态、收藏筛选，不再加一级 tab。

## 5. 核心流程

### 5.1 从图片做一个按钮

1. 工作台 →「从图片开始」，上传或粘贴截图。
2. 视觉分析返回区域框：按钮、卡片、导航、栅格区块。
3. 点击按钮区域，右侧显示文字、尺寸、颜色、圆角、阴影、字体、推断的 hover/focus 状态、置信度。
4. 点「在工作台打开」→ 创建草稿资产包（React + Tailwind + 预览 fixture）。
5. 画布中选中按钮；AI 输入「再玻璃一点，圆角 12，hover 上浮 1px」。
6. AI 返回 patch，画布实时更新；可接受/拒绝/撤销。
7. 保存 → 生成 3 个视口 × 声明状态的快照 → 出现在「组件 / 按钮」库。
8. 详情页一键复制 React、Tailwind、CSS，或「复制给 AI」。

### 5.2 从库里改造

1. 资产库 → 某个按钮 →「基于此新建」。
2. 复制为独立草稿，保留来源版本链接。
3. 工作台调整、保存为 v2。
4. 原资产不变；需要时对比或合并。

### 5.3 做布局

1. 工作台新建 → 布局 → 选模板或从参考图开始。
2. 画布切换桌面/平板/手机；布局由 slots + 栅格规则定义，不做自由拖拽。
3. 点击 slot 打开资产选择器，把按钮/卡片填入 slot（不做拖拽）。
4. 调整间距、断点、列数；预览真实页面。
5. 保存 → 复制页面代码或 Registry block。

v1 的「布局设计」= 选结构 + 填 slot + 调断点和栅格，不是画布自由拖拽。这样能覆盖后台页、营销区块、列表页等常见结构，也不会把工期拖进图形编辑器。

### 5.4 做动效

1. 工作台新建 → 动效 → 选配方或描述效果。
2. 时间轴调整 duration / easing / delay；选择触发方式。
3. 重播看效果；切换 reduced-motion 预览。
4. 保存 → 复制 CSS keyframes 或 React 组件。

### 5.5 让 AI 使用资产

1. 资产详情 →「AI 用法」tab：什么时候用、props、示例、Token、注意事项。
2. 「复制给 AI」得到一段可直接粘贴的说明 + manifest。
3. /ai-access 提供 registry 地址、MCP 工具、llms.txt 和 API Key。
4. 外部 AI 只读：搜索、读取、导出，不提供写操作。

### 5.6 做一套样式/主题

1. 工作台新建 → 样式 → 选内置配色、从参考图提取、或从零开始。
2. 编辑原始色阶和语义 Token：背景、表面、文字、边框、主色、圆角、间距、阴影。
3. 画布同时预览按钮/卡片/表格/表单四组内置示例组件（仅用于主题预览，不要求它们是 v1 可编辑资产），切换浅色/深色。
4. 对比度检查实时显示；不通过时标出具体 Token 对。
5. 保存 → 生成色板封面 + 示例组件快照 → 出现在「样式」库。
6. 复制 CSS Variables / Tailwind @theme / JSON。

主题编辑器不直接画组件，它只改 Token；组件的视觉由 Token 驱动。

### 5.7 做一套样式包

1. 工作台新建 → 样式包 → 选择主题 + 组件 + 布局的具体版本。
2. 画布展示一个完整页面 fixture；可切换主题看整体效果。
3. 保存时钉住所有依赖版本；任一依赖升级不会静默改变已发布样式包。
4. 复制完整包（theme.css + components + page）或 Registry 集合。

样式包是「组合资产」，不复制内容；它的版本历史记录依赖清单和哈希。

优先级：样式包是 Phase 5C 的可选项；时间紧时先做主题、组件、布局三个独立库，样式包后补。它不影响核心「做按钮→入库→复制」链路。

## 6. 页面设计

### 6.1 资产库

    ┌──────────────────────────────────────────────────────────────┐
    │ 资产库                                      [从图片开始] [新建] │
    │ [全部] [样式] [组件] [动效] [布局]    搜索...  标签▾ 来源▾   │
    ├──────────────────────────────────────────────────────────────┤
    │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                 │
    │ │ preview│ │ preview│ │ preview│ │ preview│                 │
    │ │ 玻璃按钮│ │ 渐变卡片│ │ 呼吸灯 │ │ 三栏布局│                 │
    │ │ 组件·按钮│ │ 组件·卡片│ │ 动效   │ │ 布局   │                 │
    │ └────────┘ └────────┘ └────────┘ └────────┘                 │
    └──────────────────────────────────────────────────────────────┘

卡片：

- 16:10 预览区，优先用快照；无快照时用实时预览兜底。
- 样式卡不是只有色块：色板条 + 按钮/卡片两个示例组件缩略图；布局卡用整页缩略图。
- 动效卡片 hover 自动播放一次；右上角「重播」；prefers-reduced-motion 时只显示静态封面。
- 角标：kind/subtype、来源、旧格式、草稿。
- 快捷操作：收藏、复制（下拉）、在工作台打开。
- 懒加载 + 骨架屏；每页 24 个，滚动加载。

筛选：

- 主 tab 决定 kind；组件 tab 出现 subtype chips。
- 标签多选；来源（手作/AI/参考/配方）；状态（全部/已发布/草稿）；收藏。
- 排序：最近更新 / 名称 / 收藏。
- 搜索匹配 name / slug / description / tags。

详情页：

    ← 资产库   玻璃按钮   [组件·按钮] [已发布]        [收藏] [在工作台打开]
    ┌──────────────────────────────────────┬───────────────────────┐
    │  预览舞台                             │ 说明                  │
    │  [桌面][平板][手机] [默认][hover]...   │ 什么时候用             │
    │  ┌────────────────────────────────┐  │ 标签 / 来源 / 版本     │
    │  │                                │  │ 依赖 Token            │
    │  │        live preview            │  │ [复制 React ▾]        │
    │  └────────────────────────────────┘  │ [复制给 AI]           │
    ├──────────────────────────────────────┴───────────────────────┤
    │ [代码] [AI 用法] [版本] [依赖]                                │
    │ React | CSS | HTML | JSON | Registry                          │
    └──────────────────────────────────────────────────────────────┘

代码 tab 提供只读高亮 + 一键复制；版本 tab 支持选两个版本并排预览 + 文件 diff。

不同 kind 的详情页有差异：

| kind | 预览 | 代码 tab | 主复制 |
| --- | --- | --- | --- |
| 样式/主题 | 色板 + 按钮/卡片示例 | CSS Variables / Tailwind @theme / JSON | CSS Variables |
| 组件 | 实时组件 + 状态 | React / CSS / HTML | React |
| 布局 | 整页 + 断点 | React / JSON | React |
| 动效 | 时间轴 + 重播 | CSS / React | CSS |
| 样式包 | 整页 fixture | JSON / manifest / theme.css | zip 或 Registry |

「复制给 AI」生成：

    你正在集成资产「玻璃按钮」(glass-button)。
    用途：...
    安装：...
    Props：...
    示例：...
    Token：...
    注意：...

### 6.2 工作台

    ┌──────────────────────────────────────────────────────────────┐
    │ 玻璃按钮 [草稿]      [桌面▾] [默认▾] [对比]   [撤销][重做][保存] │
    ├───────────────┬──────────────────────────────┬───────────────┤
    │ AI 对话       │          画布                │ 检查器        │
    │ 会话 / 历史   │  ┌────────────────────────┐  │ [设计][代码]  │
    │               │  │                        │  │ [AI][检查]    │
    │ 选中：按钮    │  │   preview iframe       │  │               │
    │ 消息...       │  │   selection overlay    │  │ Token 控件    │
    │               │  └────────────────────────┘  │ 状态 / 尺寸   │
    │ [输入框]      │  动效时间轴（动效时显示）    │ 依赖          │
    └───────────────┴──────────────────────────────┴───────────────┘

新建入口：

- 空白 / 从配方 / 从图片 / 从库内资产。
- 配方是内置的高质量起点，和旧 design-recipes 一一对应；不花 AI 调用也能直接改。
- AI 不可用时，配方、Token 控件、代码编辑仍然可用；只有生成和对话会禁用。

顶部：

- 资产名（可改）、状态徽标、设备切换、状态切换、基准/当前对比、撤销/重做、保存。
- 保存下拉：保存到库 / 仅保存草稿 / 另存为。
- 状态切换用快照，不在实时 iframe 里伪造 hover/focus；实时画布只做默认态 + 真实鼠标 hover。
- 对比模式左边是当前已保存版本的快照，右边是实时预览；没有基线时提示先保存。

左侧：

- 会话切换、历史记录。
- 消息流：用户消息、AI 说明、Patch 卡片。Patch 卡片先显示人话摘要（颜色/圆角/状态/布局变了什么），代码 diff 折叠在后面，接受/拒绝在卡片底部。
- 输入框上方显示「正在修改：按钮 · hover / 文字」作用域 chip，可清除；状态也属于作用域。
- 常用指令 chips：「更玻璃」「圆角小一点」「加 hover 上浮」「换成深色」。
- 作用域是「上下文 + diff 审核」，不是硬隔离：v1 的 patch 仍可能改到同一文件的其他部分，用户必须在 diff 里确认；v2 再考虑 AST 级局部替换。

中间：

- iframe 预览，支持缩放和背景切换（浅色/深色/棋盘格）。
- 选中元素显示描边和尺寸标签；hover 显示虚线。
- 动效资产底部时间轴：播放/暂停/拖动，触发方式切换。
- 布局资产显示 slot 边框和断点标尺。

右侧检查器：

1. 设计：颜色、圆角、间距、字体、阴影；由 manifest + Token 推导，不写死。
2. 状态：default / hover / active / focus-visible / disabled 的覆盖项；v1 通过 AI 指令或代码编辑，提供逐状态预览，不做可视化状态编排器。
3. 代码：文件树 + 编辑器；保存时校验，错误定位到行。
4. AI：ai.md 预览、manifest、复制给 AI。
5. 检查：编译结果、导入白名单、Token 对比度（仅 Token 与简单声明，任意 Tailwind 类不做语义判断）、响应式溢出、缺失状态。

保存：

- 未命名时默认「未命名按钮」，slug 自动生成。
- 保存后生成快照，显示进度；失败可重试。
- 保存成功 toast 带「查看资产」链接。

工作台桌面优先；移动端只提供预览、接受/拒绝 patch、轻量文字指令，不提供代码编辑和三栏布局。

### 6.3 参考分析

    ┌──────────────────────────────────────────────────────────────┐
    │ 从图片开始                                      [重新上传]     │
    ├──────────────────────────────┬───────────────────────────────┤
    │                              │ 区域列表                      │
    │   原图 + 区域框               │ ● 按钮 0.86                   │
    │   ┌──────────┐               │ ● 卡片 0.78                   │
    │   │          │               │ ● 导航 0.91                   │
    │   └──────────┘               │                               │
    │                              │ 选中区域详情                  │
    │                              │ 文字 / 尺寸 / 颜色 / 圆角     │
    │                              │ hover 推断 / 置信度           │
    │                              │ [在工作台打开]                │
    └──────────────────────────────┴───────────────────────────────┘

- 区域框按 role 着色；可开关、缩放、点击。
- 低置信度显示「需确认」，不自动采纳。
- 原图、区域坐标、模型、置信度、保留期限都入库。
- 默认 inspiration_only，不声称复制源码；不自动发布。

### 6.4 AI 接入页

- 已发布资产数量、最近更新。
- API Key 状态 / 配置入口。
- 三个复制块：REST 示例、MCP 配置、llms.txt 地址。
- 工具列表：search_assets / get_asset / get_asset_code / list_style_tokens。
- 明确「只读，不提供写入」。

### 6.5 组件清单

新增：

- AssetCard / AssetGrid / AssetFilters / AssetTabs
- PreviewStage / DeviceSwitcher / StateSwitcher / SelectionOverlay
- CodePanel / FileTree / CodeEditor
- AiChatPanel / MessageBubble / PatchCard / PatchDiff
- TokenControl / InspectorPanel / ChecksPanel
- MotionTimeline
- ReferenceUploader / RegionOverlay / RegionList
- UsageManifestPanel / CopyMenu / VersionList

复用：

- Button / Input / Textarea / Tabs / Dialog / Badge / Card / Skeleton / EmptyState / PageHeader。

## 7. 数据模型

### 7.1 复用

继续使用：

- DesignDocument：资产根。
- DesignVersion：不可变版本，content 存 manifest JSON。
- DesignDraft：工作台草稿；新工作台用 DesignDraftFile / DesignDraftSnapshot 存工作副本与撤销点。
- DesignDraftVersion：只为旧流程保留，新工作台不依赖它。
- CandidateProposal：AI 提案 / patch 记录。
- PreviewSnapshot：视口快照。
- ReferenceSnapshot：参考来源与保留策略。
- DesignTask：快照、AI、渲染任务。
- ChangeSession：工作台会话。

### 7.2 DesignDocument 新增字段

    format            String  @default("token") // token | package | legacy
    subtype           String?
    description       String?
    whenToUse         String?
    source            String  @default("manual") // manual | ai | reference | recipe | import
    favorite          Boolean @default(false)
    externalVersionId String?  // 对外 AI 锁定的版本；null = 不对外
    // visibility 沿用现有字段：internal | external
    // Prisma 需要单独的 externalVersion 关系；不能复用 currentPublishedVersion 的关系名

DesignVersion 也必须增加 format：

    format String @default("token") // token | package | legacy

原因：旧资产从 legacy 转成 package 后，旧版本的内容仍是旧格式；如果只按 DesignDocument.format 解释历史版本，回滚/对比会失败。版本格式必须跟着版本走。

### 7.3 PreviewSnapshot 新增字段

    state  String @default("default") // default | hover | focus-visible | disabled
    kind   String @default("full")    // full | thumb
    format String @default("png")     // png | webp
    width  Int?
    height Int?

同一 versionId + viewport + state + kind 只保留一张；重跑覆盖旧产物，避免快照无限增长。

### 7.4 新增表

    model DesignAssetFile {
      id        String   @id @default(uuid())
      versionId String
      path      String
      target    String?
      type      String   // registry:ui | registry:block | registry:file | asset:preview | asset:fixture | asset:doc
      language  String   // tsx | css | json | md
      content   String
      createdAt DateTime @default(now())

      version DesignVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)

      @@unique([versionId, path])
      @@index([versionId])
      @@map("design_asset_files")
    }

    model DesignDraftFile {
      id        String   @id @default(uuid())
      draftId   String
      path      String
      content   String
      updatedAt DateTime @updatedAt

      draft DesignDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)

      @@unique([draftId, path])
      @@index([draftId])
      @@map("design_draft_files")
    }

    model DesignDraftSnapshot {
      id        String   @id @default(uuid())
      draftId   String
      manifest  String   // manifest.json 快照
      files     String   // JSON：{ path: content }，用于撤销
      createdAt DateTime @default(now())

      draft DesignDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)

      @@index([draftId, createdAt])
      @@map("design_draft_snapshots")
    }

    model DesignAssetTag {
      id    String @id @default(uuid())
      name  String @unique
      slug  String @unique
      links DesignAssetTagLink[]
      @@map("design_asset_tags")
    }

    model DesignAssetTagLink {
      documentId String
      tagId      String

      document DesignDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
      tag      DesignAssetTag @relation(fields: [tagId], references: [id], onDelete: Cascade)

      @@id([documentId, tagId])
      @@index([tagId])
      @@map("design_asset_tag_links")
    }

    model StudioMessage {
      id          String   @id @default(uuid())
      sessionId   String
      role        String   // user | assistant | system
      content     String
      candidateId String?  // 权威 patch 在 CandidateProposal，避免两份 patch 漂移
      summary     String?
      status      String   @default("done") // done | proposed | applied | rejected | failed
      createdAt   DateTime @default(now())

      session ChangeSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

      @@index([sessionId, createdAt])
      @@map("studio_messages")
    }

    model ReferenceAnalysis {
      id               String   @id @default(uuid())
      snapshotId       String?
      sourceResourceId String?
      imageHash        String
      model            String
      width            Int
      height           Int
      globalProfile    String?  // JSON：色板/字体/间距/氛围；避免 SQL 关键字 global
      regions          String   // JSON：区域数组
      status           String   @default("ready") // ready | adopted | failed
      createdAt        DateTime @default(now())

      snapshot ReferenceSnapshot? @relation(fields: [snapshotId], references: [id], onDelete: SetNull)

      @@index([imageHash])
      @@index([snapshotId])
      @@map("reference_analyses")
    }

ChangeSession 增加：

    documentId           String?
    draftId              String?
    referenceAnalysisId  String?
    title                String?
    lastMessageAt        DateTime?

DesignDraft 增加：

    manifest  String?                // 工作副本的 manifest.json
    files     DesignDraftFile[]      // 工作副本文件
    snapshots DesignDraftSnapshot[]  // 撤销快照

对应 Prisma 关系需要补：DesignVersion.files、DesignDocument.tags、ChangeSession.messages、ReferenceSnapshot.analyses、DesignDraft.files、DesignDraft.snapshots。迁移时一并生成。

草稿与版本的关系：

- 新建资产时创建 v1 baseline（publishedAt=null）作为基线，DesignDraft.baseVersionId 指向它。
- 首次「保存到库」直接把这个 baseline 发布成 v1（写入当前工作副本），不要先建 baseline 再建 v2，否则用户看到的第一个版本号会是 v2。
- 工作台自动保存只写 DesignDraft.manifest + DesignDraftFile，不产生版本。
- 每次应用 patch 或显式「保存检查点」时，把工作副本写成 DesignDraftSnapshot（manifest + files JSON）；不消耗 DesignVersion 版本号。
- 撤销 = 把工作副本恢复成上一个 DesignDraftSnapshot；不修改历史版本。
- 后续「保存到库」= 从当前工作副本创建 published DesignVersion + DesignAssetFile；版本号只给已保存/已发布版本使用。
- 保存成功后关闭当前草稿（status='published'）和当前 ChangeSession（status='closed'）；继续编辑时基于新发布版本创建新草稿/新会话。不要继续用旧 baseVersionId 提交 patch，否则会不断 409。
- 发布事务里更新 currentPublishedVersionId、DesignAssetFile、DesignDraft 状态，三者必须同事务提交。
- 「保存到库」只更新 currentPublishedVersionId，不自动对外。对外需要单独「锁定对外版本」：设置 externalVersionId + visibility='external'；取消锁定则清空 externalVersionId。
- 外部 AI 只读 externalVersionId，不读 currentPublishedVersionId；这样库内继续迭代不会把半成品暴露给外部。
- DesignDraftVersion 保留给旧流程；新工作台不依赖它，避免草稿检查点把 v1/v2 编号吃掉。

### 7.5 版本内容

- DesignVersion.content 存 manifest.json，不含文件正文。
- 文件正文存 DesignAssetFile，按 versionId 关联；包括源码、preview/fixture、生成的 ai.md/README。
- manifest.files 只描述对外交付文件；preview/fixture 通过 preview.entry 引用，不进入 Registry。
- 保存时校验 manifest.files 与 DesignAssetFile 路径一一对应（preview/fixture/ai.md/README 例外），避免清单和实际文件漂移。
- contentHash = manifest 语义内容 + 所有文件正文的排序哈希；不含 id、时间戳、预览路径。
- manifest.assetDependencies 同步写入现有 DesignDependency，供依赖图和版本钉住使用。
- DesignDocument 是库元数据的唯一来源（name/slug/kind/subtype/tags/description/whenToUse/favorite/status）；manifest 里的同名字段在保存时从 document 同步，避免两套元数据漂移。
- Token 资产仍然把 Token 文档放在 content，format='token'。
- 旧组件/动画 format='legacy'，可读、可复制旧导出，不参与新工作台。

### 7.6 保存语义

- 工作台自动保存草稿到 DesignDraft.manifest + DesignDraftFile。
- 用户点「保存到库」：先同步跑 manifest/代码/预览校验；通过后创建新的 DesignVersion，status='published'（即库内可见），再异步触发快照任务。
- 快照失败不阻塞入库：资产可见，但卡片显示「预览生成中/失败」并可重试；不能把失败静默成空白封面。
- 「仅保存草稿」：只更新草稿，不出现在库。
- 版本历史不删除；恢复历史 = 创建新版本。
- slug 冲突返回 409，前端建议加后缀；不要自动静默改 slug。
- 取消审核强制流程；只有可选的「锁定版本」用于对外发布。

### 7.7 并发与冲突

- 保存资产、应用 patch 都带 baseVersionId；草稿写入同时校验 DesignDraft.lockVersion。
- 基准版本过期或 lockVersion 不一致返回 409；前端提示「基于新版本重试」或「另存为」。
- 自动保存只更新草稿，不创建正式版本。
- 同一资产同一时间只允许一个编辑会话；第二个会话进入只读或 fork。

## 8. API 设计

所有内部接口继续走 /api/design-proxy + DESIGN_INTERNAL_API_KEY。
外部只读继续用 DESIGN_READ_API_KEY。

鉴权边界：

- 8.1 / 8.2 / 8.3：内部守卫，浏览器不持有内部 key。
- 8.4 的 catalog / asset / llms.txt / tools / mcp / published export：外部只读 key。
- /design/assets 列表和 /design/ai/catalog 是两套口径：前者给运营台，后者只返回已发布摘要。

### 8.1 资产库

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /design/assets | 列表/搜索；参数 kind subtype tag q status favorite sort cursor |
| GET | /design/assets/:idOrSlug | 详情 + manifest + 文件清单 + 依赖 |
| GET | /design/assets/:id/versions | 版本历史 |
| GET | /design/assets/:id/versions/:versionId | 单版本 manifest + 文件清单 |
| GET | /design/assets/:id/versions/:versionId/preview?viewport=desktop | 单版本快照（版本对比用） |
| GET | /design/assets/:id/versions/:versionId/diff?againstVersionId=... | 结构化文件 diff（版本对比用） |
| GET | /design/assets/:id/preview?viewport=desktop&state=default | 快照图 |
| GET | /design/assets/:id/export?format=react | 导出 |
| POST | /design/assets/:id/fork | 基于此新建 |
| POST | /design/assets/:id/favorite | 收藏 |
| PATCH | /design/assets/:id | 名称/描述/标签/状态 |
| DELETE | /design/assets/:id | 归档（软删除） |
| POST | /design/assets/:id/restore | 从归档恢复 |
| POST | /design/assets/:id/versions/:versionId/restore | 恢复历史版本为新版本 |
| POST | /design/assets/:id/release | 锁定对外版本：{versionId}，设置 externalVersionId + visibility=external |
| DELETE | /design/assets/:id/release | 取消对外锁定，清空 externalVersionId |

export format：

    react | css | tailwind | html | json | registry | ai

导出返回结构统一为：

    {
      "format": "react",
      "files": [
        { "path": "components/ui/glass-button.tsx", "content": "...", "type": "registry:ui" }
      ],
      "dependencies": ["clsx"],
      "cssVars": { "radius-md": "10px" },
      "install": "npx shadcn@latest add <registry-url>",
      "notes": "需要宿主项目已有 Tailwind 4"
    }

### 8.2 工作台

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /design/studio/sessions | 新建会话；入参 assetId? referenceAnalysisId? kind |
| GET | /design/studio/sessions/:id | 会话 + 消息 + 当前草稿 |
| POST | /design/studio/sessions/:id/messages | 发送消息，创建 ai_chat 任务；返回 messageId + taskId |
| GET | /design/studio/sessions/:id/messages/:messageId/stream | 订阅该消息的 SSE（delta / patch / validation / done） |
| POST | /design/studio/sessions/:id/apply | 应用 patch |
| POST | /design/studio/sessions/:id/reject | 拒绝 patch |
| POST | /design/studio/sessions/:id/undo | 撤销到上一草稿版本 |
| PUT | /design/studio/sessions/:id/files/*path | 手动编辑文件；路径做编码与穿越校验 |
| POST | /design/studio/sessions/:id/preview | 重新编译预览 |
| POST | /design/studio/sessions/:id/save | 保存到库；入参名称/slug/标签/publish |
| GET | /design/studio/sessions/:id/files | 文件树 + 内容 |

### 8.3 参考分析

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /design/references/analyze | 上传图片或传 resourceId；返回 analysisId + regions |
| GET | /design/references/:id | 分析结果 |
| GET | /design/references/:id/image | 原图/缩略图 |
| POST | /design/references/:id/regions/:regionId/adopt | 采纳为草稿，返回 sessionId |
| POST | /design/references/:id/regions/:regionId/analyze | 单区域二次分析（可选） |

### 8.4 AI 接入

这一组接口全部走 DESIGN_READ_API_KEY；不提供写操作。
只返回 status='published'、visibility='external' 且 externalVersionId 非空的版本；没有锁定对外版本的资产直接 404，不回退到 currentPublishedVersionId。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /design/ai/catalog | 已发布资产摘要 |
| GET | /design/ai/assets/:slug | 单资产详情 + ai.md |
| GET | /design/ai/llms.txt | 全库索引 |
| GET | /design/ai/tools | 工具清单 |
| POST | /design/mcp | MCP JSON-RPC |
| GET | /design/published/:slug/export?format=registry | Registry 安装 |

### 8.5 错误与限制

- SSE 经 Next 代理时不能用缓冲式 rewrite；用 Route Handler 透传流，并关闭压缩/缓冲。
- Registry 地址需要 PUBLIC_BASE_URL 或 DESIGN_REGISTRY_BASE_URL；内部 CLI 安装要么内网可达，要么使用短期签名 URL，不要把 READ key 写进安装命令。
- 图片：最大 10MB、最大 8000×8000，只允许 png/jpeg/webp；SVG 先拒绝。
- 资产文件：单文件 200KB，总包 1MB，文件数 40。
- AI：单会话消息数、Token 上限、每日费用上限；超限返回结构化错误。
- 快照：default 3 个视口 + 交互态 desktop，单次任务超时；失败可重试。
- 所有写接口带 Idempotency-Key，避免重复保存。
- 草稿过期时间沿用 DesignDraft.expiresAt（建议 7 天）；过期草稿和 DesignDraftFile 清理。
- 每个草稿只保留最近 50 个 DesignDraftSnapshot；更老的撤销点清理，避免无限增长。
- 定期清理：孤立 DesignAssetFile、失败任务的临时产物、过期 ReferenceSnapshot、无引用的快照文件。

## 9. 预览与渲染

### 9.1 实时预览

预览采用「浏览器内 React bundle」，不在 Node 里执行资产代码：

1. esbuild 以 platform=browser 把 preview/preview.tsx + 组件文件 + 白名单依赖（含 React/ReactDOM）打包成单文件 JS。assetDependencies 由编译器解析成本地包文件，不走网络。
2. Tailwind 编译所有资产文件用到的类，生成 CSS；自定义 CSS 作用域到 .aurum-<slug>。
   - 用 @tailwindcss/node 或 @tailwindcss/postcss 指向资产文件（必要时生成虚拟 source 文件），按 manifest+files 哈希缓存结果。
   - 主题用 @theme / CSS 变量注入；light/dark 两组都编译。
3. 生成 HTML 壳：根节点 + inline CSS + inline JS + 选中桥接脚本。
4. iframe 使用 sandbox="allow-scripts"（不加 allow-same-origin），CSP 禁止网络。
5. React 在 iframe 里挂载并渲染；点击 [data-part] 时 postMessage 给父页面。

这样既支持 hooks / 真实交互，又不需要在服务端执行不可信组件代码；预览、快照、复制的 React 都来自同一份入口。

编译放在独立 preview worker，不占 API 请求线程；API 只存产物和状态。编译结果按 manifest+files 哈希缓存，手动编辑 debounce 300ms。

默认新增 apps/design-renderer：

- 输入：manifest + files + theme CSS；输出：bundle HTML/CSS/元数据。
- 不接数据库、不持 API key、不访问外网；只接受内部队列/HTTP 请求。
- API 负责编排、存储和权限；renderer 超时/重试由任务系统处理。
- 如果部署成本不允许，退回 worker 内独立模块，但仍只做编译，不执行资产 React 代码。
- Phase 0 允许先在 API 内用 PreviewCompileService 验证链路；Phase 1 再按同一接口抽到 apps/design-renderer，前端和 API 契约不变。

CSP 至少：

    default-src 'none';
    style-src 'unsafe-inline';
    img-src data: blob:;
    font-src data:;
    script-src 'unsafe-inline';   /* bundle + 选中桥接 */
    connect-src 'none';
    frame-src 'none';
    object-src 'none';
    base-uri 'none';
    form-action 'none';

父页面只接受 iframe.contentWindow 发来的固定消息类型（选中、尺寸），并校验来源；不把 postMessage 内容当作可信输入。

风险与限制：

- iframe 内仍是任意 JS，必须加 watchdog：超时、无响应、CPU 占用过高时终止预览并提示；Playwright 侧设置 page 超时。
- 不允许 allow-same-origin / allow-popups / allow-top-navigation / allow-modals。
- 预览 HTML 不落成可被其他页面直接打开的公开文件；只作为受控产物或 iframe srcdoc。
- HTML 导出用 Playwright 渲染后 page.content() 抓取静态 DOM，再剥离脚本；React 导出仍是主要交付。

Phase 0 先验证 esbuild(browser) + Tailwind 4 + iframe 渲染 + Playwright 快照的组合；如果 Tailwind 编译成本过高，退回「保存时预编译 CSS」，但不改成 react-dom/server。

Go/No-Go：如果预览编译 P95 超过 2s、快照超过 15s，或 iframe 无法稳定隔离，就先把 v1 收窄到「Token + 预设模板 + 静态快照」，不要带着不稳定预览进入 Phase 1。

### 9.2 快照

- 保存时创建 asset_snapshot 任务。
- Playwright 打开独立的 preview artifact（不是工作台页面，也不依赖 iframe 嵌套），固定视口：mobile 390×844、tablet 768×1024、desktop 1440×900。
- preview artifact 用受控本地文件/短期签名 URL，不写成公开静态页面。
- preview fixture 必须确定性：固定数据、固定 locale、不用 Math.random / Date.now / 实时网络；需要随机时用固定 seed 注入。
- 截图前等待字体加载，并把动画暂停在固定帧（或设置固定 animation-delay），否则视觉回归会抖。
- default 状态生成 3 个视口；hover / focus-visible / disabled 默认只生成 desktop，资产声明需要多视口时再加。
- 库封面用 desktop/default；快照是异步的，未完成时显示占位和进度。
- 状态快照的触发方式必须固定：hover 用 Playwright hover，focus-visible 用键盘 Tab，disabled 用 fixture prop；不能只改 CSS 类名冒充状态。
- 存 WebP/PNG + 元数据：浏览器版本、视口、资产版本哈希、生成时间。
- 快照哈希与 manifest+files 哈希不一致时标记 stale，库卡片显示「重新生成」。

### 9.3 一致性

- 实时预览和快照使用同一个 preview.entry。
- 不允许审核台再用 fixture JSON 代替真实组件。
- 旧资产 format='legacy' 继续用旧渲染，但显示「旧格式」标识。

### 9.4 性能

- 库列表只加载 thumb（480px），详情默认加载 full 快照；点「交互预览/重播」时再加载 live iframe。
- 快照走静态文件服务 + 长缓存；版本变化换文件名。
- 预览 iframe 懒加载；库卡片用 IntersectionObserver。
- 代码编辑器按需加载（动态 import）。

## 10. 图片参考分析

### 10.1 流程

1. 校验图片大小/类型；存原图 + hash。
2. 视觉模型返回结构化 JSON：

    {
      "canvas": { "width": 1440, "height": 900 },
      "global": {
        "palette": [{ "hex": "#0B1220", "role": "background" }],
        "typography": { "familyTrait": "几何无衬线", "density": "comfortable" },
        "spacing": { "unit": 8 },
        "mood": ["冷静", "专业"]
      },
      "regions": [
        {
          "id": "r1",
          "role": "button",
          "bbox": { "x": 120, "y": 640, "w": 180, "h": 48 },
          "confidence": 0.86,
          "text": "开始使用",
          "styles": {
            "background": "#3B82F6",
            "color": "#FFFFFF",
            "radius": "10px",
            "fontSize": "14px",
            "fontWeight": 600,
            "padding": "12px 24px",
            "shadow": "0 8px 24px rgba(59,130,246,.35)"
          },
          "states": { "hover": { "transform": "translateY(-1px)" } },
          "codeHint": "primary CTA with soft glow"
        }
      ]
    }

3. 校验坐标/颜色/尺寸；与本地色板提取合并。
4. 按需裁剪区域做二次分析（更精确的字体、圆角、阴影）。
5. 选中区域后生成 React + Tailwind 草稿；生成失败则只保留 spec。
6. 存 ReferenceAnalysis + ReferenceSnapshot，默认保留 30 天。

### 10.2 采纳

- 采纳 = 创建草稿资产包，source='reference'，记录 referenceAnalysisId。
- 采纳时必须先解决 Token 来源：使用当前选中的主题，或从参考图全局色板创建一个 draft theme，再把区域颜色映射成覆盖 Token。不能生成一个没有 Token 来源的组件。
- 映射后的颜色要标出「来自参考 / 人工调整 / AI 推断」，方便后续修正。
- 不直接发布；必须经过工作台预览和保存。
- 参考内容是不可信数据：图片里的文字不能触发工具调用，不改变系统策略。

### 10.3 降级

- AI 不可用：只做色板/主色提取，明确提示「布局与组件识别需要 AI」。
- 区域识别失败：允许用户手动画框，再对框内区域分析。
- 低置信度区域不自动生成代码，只保留 spec，等待人工确认。

### 10.4 范围与坐标约定

- v1 只做图片参考；URL 仅保留现有元数据链路，不做网页截图、DOM 抓取或浏览器自动化。
- bbox 统一用原图像素坐标，左上角为原点；上传后如果前端缩放，只影响显示，不影响存储坐标。
- 裁剪区域时外扩 8–16px，避免阴影/描边被切掉；二次分析使用原图裁剪，不用缩略图。
- 参考图有 EXIF 方向时先纠正再分析；限制解码后像素总量，防止解压炸弹。
- 静态图片无法可靠判断 hover/滚动/过渡/弹簧等效果；推断出的状态只是假设，必须标记置信度并人工确认。v2 可支持多帧/GIF/短视频参考。
- 采纳只生成草稿，不复制第三方源码；来源和 rights 状态写入 provenance。
- 参考快照到期删除后，已发布资产仍保留 provenance 的哈希/摘要；不要依赖原图才能解释资产来源。
- 置信度低于阈值：标「需确认」，不自动生成代码。

## 11. AI 对话与 Patch

### 11.1 会话上下文

每次请求只带：

- 当前 manifest。
- 选中 part 对应的源码片段。
- 当前状态（default / hover / focus-visible / disabled），如果用户在某个状态快照下提问。
- 资产用到的 Token。
- 参考分析摘要（如果有）。
- 最近 N 条消息。

不带整个库、不带无关资产、不带参考原图（只带结构化摘要）。

### 11.2 消息协议

AI 对话不直接在请求线程里调模型：POST messages 创建 ai_chat 任务，SSE 订阅任务输出。任务可取消、超时、重试；patch 只在任务成功后落库。这样和现有 DesignTask 的租约/重试/取消机制一致。

SSE 事件：

    message.delta     文本增量
    patch.proposed    patch 预览
    patch.applied     已应用
    validation        语法/预览/检查结果
    done              结束
    error             结构化错误

Patch 格式：

    {
      "schema": "aurum.asset-patch.v1",
      "baseVersionId": "ver_01J...",
      "summary": "增加玻璃高光并收紧圆角",
      "operations": [
        {
          "op": "replace_file",
          "path": "files/button-glass.tsx",
          "content": "..."
        },
        {
          "op": "set_manifest",
          "path": "/tokens",
          "value": ["color.primary", "radius.sm"]
        }
      ]
    }

允许的操作：

- replace_file / delete_file
- insert_file：必须同时给 path、content、target、type、language
- set_manifest（JSON Pointer）
- replace_tokens（仅主题资产）

拒绝：任意 shell、SQL、网络、文件系统路径。

不可被 AI patch 修改的字段：id、slug、version、format、source、provenance、createdAt、publishedAt，以及库元数据 name/tags/description/whenToUse（这些在 UI 里改）。assetDependencies 只能指向已发布版本，且不能借 patch 越权升级依赖。

### 11.3 应用流程

1. ai_chat 任务完成，模型返回 patch。
2. 服务端校验 schema、路径、导入、语法、禁用模式、大小。
3. 编译预览；失败则自动修复一次，再失败返回错误。
4. 创建 CandidateProposal，状态 planned（提案）；渲染/校验后 validated。
5. 前端展示 diff；用户接受 → 在一个事务里写 DesignDraftFile、DesignDraftSnapshot，并把 CandidateProposal 标记 selected。
6. 拒绝 → CandidateProposal 标记 rejected，不改草稿。
7. 撤销 → 恢复到上一个 DesignDraftSnapshot。

不要直接写 proposed / applied：现有 CandidateProposal 的状态机是 planned -> generated -> rendered -> validated -> selected | rejected | expired。StudioMessage 自己的 status 可以单独用 proposed / applied，但不要把两套状态混在同一个字段。

### 11.4 模型配置

复用 ai-settings：

- design.studio：对话与 patch。
- design.vision：图片区域分析。
- design.reference：区域二次分析/代码生成。

每个功能单独限流、费用上限、超时。

## 12. 复制、导出与 AI 接入

### 12.1 复制格式

| 格式 | 内容 | 主要场景 |
| --- | --- | --- |
| React | TSX + 依赖 + 用法 | 贴回 Next 项目 |
| CSS | 作用域 CSS + Token 变量 | 任意项目 |
| Tailwind | 类名 + CSS 变量 + @theme 片段 | Tailwind 4 项目 |
| HTML | 自包含 HTML + CSS | 快速预览/邮件 |
| JSON | manifest + files | 程序消费 |
| Registry | shadcn registry item | 一条命令安装 |
| AI | ai.md + manifest + 示例 | 给 Cursor/Claude 用 |

### 12.2 复制交互

- 详情页主按钮「复制 React」；下拉切换格式。
- 复制成功 toast；失败回退到可选文本框。
- 「复制给 AI」生成精简说明，不包含无关文件。
- 「复制安装命令」：npx shadcn@latest add <registry-url>。
- 布局/样式包复制时必须带 assetDependencies：默认把依赖文件一起打包，或生成 registryDependencies 链接；不能只复制页面文件导致缺组件。
- 多文件资产提供「复制全部」和「下载 zip」；剪贴板只适合单文件/合并文本。
- 复制 CSS 时自定义样式会加 .aurum-<slug> 前缀，但 Tailwind utilities 仍是全局类名；Tailwind 项目优先用 React 导出。

### 12.3 外部 AI

- 只读 REST + MCP。
- 只读 visibility='external' 且 externalVersionId 指向的对外版本；不读库内最新的 currentPublishedVersionId。
- 返回先摘要后详情，避免占满上下文。
- 不返回参考原图、旧格式内部字段、未发布草稿。
- 记录 key 指纹、客户端、端点、时间。

优先级：如果 v1 只做内部使用，ai.md + 「复制给 AI」已经够用；MCP / 外部 REST / externalVersionId 可以延后到 v1.5。不要把外部消费当成阻塞核心链路的任务。

工具契约：

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| search_assets | query kind? tags? limit? | slug / name / kind / summary / tags / version |
| get_asset | slug version? | manifest + ai.md + 依赖 |
| get_asset_code | slug format version? | files + dependencies + cssVars |
| list_style_tokens | themeSlug? | 语义 Token 列表 + CSS 变量名 |

约束：

- 默认只返回已发布版本；指定 version 时必须是 published。
- 不提供 write / publish / delete 工具。
- 单次返回有大小上限；超过上限返回摘要 + 分页/分段读取提示。

## 13. 安全与权限

- 内部 UI：DESIGN_INTERNAL_API_KEY，只由服务端代理注入；浏览器不持有。
- 外部读取：DESIGN_READ_API_KEY；生产必须配置。
- 代码资产：导入白名单 + 禁用模式 + esbuild 解析 + CSS 作用域。
- 预览：iframe sandbox="allow-scripts"，不加 allow-same-origin，也不加 allow-popups / allow-top-navigation / allow-modals；CSP default-src 'none'，禁止网络。
- 预览编译 worker 只做 esbuild + Tailwind 编译，不执行资产 React 代码；渲染只在 iframe 内发生。
- iframe watchdog：加载/交互超时、无响应、CPU 占用过高时销毁 iframe 并提示；不允许预览无限运行。
- 预览 HTML 只作为受控产物/srcdoc，不写成公开可访问的静态页面。
- 快照：Playwright 拦截所有请求，只加载本地预览产物，并设置 page 超时。
- 图片：限制大小/类型；SVG 拒绝；参考文本按不可信数据处理。
- 存储：快照/原图定期清理；参考保留 30 天；资产版本永久保留。
- 审计：AI 调用、发布、外部读取、MCP 调用。

## 14. 迁移与下线

### 14.1 数据

- 迁移前备份数据库和 storage；先在副本跑迁移并核对 document/version/file 数量。
- 迁移只做加法，不在 v1 删除旧列/旧表；旧接口保留一个版本。
- 现有 theme/foundation/style_pack：document/version 都回填 format='token'，内容不变。
- 现有 component/animation/layout：document/version 都回填 format='legacy'，继续可读、可复制旧 CSS。
- 不能只靠 DesignDocument.format 的默认值：必须按 kind 回填 document 和所有历史 version 的 format，否则回滚旧版本时会被新校验器拒绝。
- 提供「转换为资产包」：用旧导出生成 React 包装 + CSS + preview，人工确认后保存为新版本。
  - 这是 best-effort：旧组件只有声明片段，没有真实组件结构，转换结果可能只是一个通用包装，不能假装等价。
  - 转换前明确提示「需要人工重写」，转换后保留 legacy 版本可回退。
- 已发布资产补跑快照任务；失败的保留旧预览并标记。
- 标签按 kind/subtype 回填；用户可编辑。
- 现有已发布资产的 externalVersionId 默认保持 null；需要对外时逐个「锁定对外版本」。不要迁移时批量开放外部访问。
- /style/analyze 保留为底层视觉分析能力，新 /design/references/analyze 包装它并负责持久化、区域和权限。

### 14.2 页面

- /style-lab → /studio/new?mode=reference，保留一个版本的跳转。
- /design-library → /studio/new。
- /design-library/review → /library?status=draft。
- 审核台代码移到资产详情的历史页；候选/版本 API 保留。
- 删除未使用的向导组件前先确认无引用。
- design-examples.spec.ts 依赖 design-library/page.tsx 的示例抽取；页面下线时同步改测试，不要留下假绿。
- 旧快照是 fixture 渲染，不能作为新库封面；迁移时重跑，失败则显示「旧格式」。

### 14.3 兼容

- 旧资产在库中显示「旧格式」；详情页仍可预览/复制旧导出。
- 新工作台只处理 format='package'；旧资产需先转换。
- API 保留 /design/documents/* 一个版本，逐步迁移到 /design/assets/*。
- 现有 /design/published/* 先保持旧行为，新增 /design/ai/* 使用 externalVersionId；不要让两套外部接口混用同一口径。迁移完成后再下线旧接口。

## 15. 实施阶段

### Phase 0：规范与验证

交付：

- 本文档 + manifest schema + patch schema。
- 预览编译 spike：一个按钮 TSX → esbuild browser bundle → iframe → Playwright 快照。
- 安全验证：导入白名单、禁用模式、CSP、iframe 逃逸、CPU  watchdog。
- 数据迁移草案。

验收：

- 示例按钮在预览中可 hover/focus，且支持一个 useState 交互。
- 三个视口快照生成。
- 复制的 React 代码能在 Next + Tailwind 测试项目编译。
- 预览 iframe 无任何网络请求；无 allow-same-origin。

### Phase 1：后端资产包

交付：

- Prisma 变更 + 迁移。
- 资产 CRUD、文件表、标签、搜索、版本。
- 导出：React/CSS/HTML/JSON/Registry/AI。
- 内部/外部鉴权。
- 资产快照任务 + 缩略图存储随 Phase 2 的库卡片一起做；Phase 1 先用详情实时预览。
- 不要继续把逻辑堆进 design.service.ts（当前已接近 2000 行）：拆成 DesignAssetService、DesignStudioService、DesignReferenceService、DesignPreviewService；控制器也按资源拆。
- 依赖关系走 dependency-cruiser 规则，新增模块不得互相直接访问 repository。

验收：

- API 可创建按钮资产包、列出、搜索、导出。
- 保存触发快照；失败可重试。
- 未发布资产不出现在外部检索。

### Phase 2：资产库

交付：

- /library 列表、tab、筛选、搜索。
- 资产卡片、详情页、代码 tab、AI 用法 tab、版本 tab。
- 资产快照任务 + 缩略图存储；卡片用真实快照，详情可切实时预览。
- 复制菜单、收藏、在工作台打开。
- 旧格式标识。

验收：

- 24 个种子资产可浏览；滚动加载。
- 卡片有快照；动效 hover 播放。
- 复制 React/CSS/Registry 成功。
- 移动端可用。

### Phase 3：工作台 + 最小参考（按钮垂直切片）

交付：

- 三栏工作台、画布、设备/状态切换。
- 选中桥接、检查器、代码面板。
- AI 对话、patch 预览、接受/拒绝/撤销。
- 保存到库、自动保存、版本。
- 最小参考入口：上传单图、识别按钮/卡片、采纳为草稿。

验收：

- 从图片里的按钮 → 采纳 → 工作台调整 → 保存 → 库中出现 → 复制 React。
- 从配方创建一个按钮 → AI 改成玻璃 → 保存 → 库中出现。
- patch 失败有可读错误；撤销恢复。
- 复制出的 React 与预览一致。

### Phase 4：参考分析增强

交付：

- 多区域列表、手动框选、区域二次分析。
- 置信度、来源/权利状态、保留策略。
- 低置信度确认流程。

验收：

- 复杂截图可手动补框；低置信度不自动生成代码。
- AI 不可用降级为色板提取。
- 参考原图不进入外部检索。

### Phase 5：动效、布局、主题

Phase 5A：动效

- 动效资产包、时间轴、重播、reduced-motion。
- 验收：三个视口快照；时间轴可拖动；prefers-reduced-motion 生效。

Phase 5B：布局

- 布局资产包、slots、断点、slot 选择器。
- 验收：手机/平板/桌面无溢出；slot 可替换。

Phase 5C：主题 / 样式包

- 主题编辑器、Token 对比度检查、示例组件预览。
- 样式包依赖钉版本、完整页面 fixture。
- 验收：换主题后组件 Token 正确解析；样式包依赖升级不静默改变旧版本。

### Phase 6：AI 接入

交付：

- /ai-access、llms.txt、registry 地址、MCP 工具。
- 外部 key 管理、限流、审计。

验收：

- 外部 AI 用 key 搜索/读取/复制资产。
- MCP 工具返回正确结果。
- 无写操作暴露。

### Phase 7：硬化、灰度与清理

每个 Phase 的验收都必须带单测/集成测试；这一阶段只做全量回归和上线准备。

交付：

- 全量回归：manifest 校验、patch 校验、导入白名单、CSS 作用域、路径穿越。
- 视觉回归：Playwright 三视口 + 状态快照；与基线比对。
- 安全回归：脚本、网络请求、超大文件、SVG、恶意导入、iframe 逃逸、CPU 占用。
- 灰度：DESIGN_STUDIO_V2 开关；旧资产双读；先内部账号，再全量。
- 清理：旧向导组件、未引用 API、临时跳转。

验收：

- 关键链路 e2e 全绿。
- 视觉回归无意外差异。
- 灰度期间无 P0/P1 问题。
- 旧资产可读；新资产可创建；旧路由 redirect 正常。

## 16. 总体验收

- 从图片里的按钮到复制出可用的 React 代码，全流程不超过 8 次点击。
- 预览编译 P95 < 2s，快照任务 P95 < 15s，库首页 LCP < 2.5s（本地/内网口径）。
- 交互组件必须支持键盘 focus-visible；动效必须响应 prefers-reduced-motion；库和工作台控件可用键盘操作。
- 库中每个已发布资产都有 3 个视口 × 声明状态的快照 + ai.md（不适用视口的资产除外）。
- 预览、快照、复制代码三者一致。
- AI 对话可以改选中元素，支持接受/拒绝/撤销。
- 布局支持 slots + 断点，不需要自由拖拽也能表达常见页面。
- 动效支持重播和 reduced-motion。
- 一键复制覆盖 React/Tailwind/CSS/HTML/Registry/AI。
- 外部 AI 只能读「已锁定对外」的版本，不能写；库内新保存的资产在锁定前不可见。
- 旧资产仍可查看，不阻塞迁移。
- 预览沙箱无网络、无 same-origin、无顶层导航/弹窗；脚本只能在 iframe 内运行。

## 17. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 浏览器 bundle + Tailwind 编译复杂 | 预览慢/失败 | Phase 0 spike；限制导入；按哈希缓存编译产物 |
| 视觉模型 bbox 不准 | 区域选不中 | 手动画框兜底；置信度；二次分析 |
| AI 生成代码质量不稳 | 复制出去不可用 | 配方起步、编译校验、自动修复、diff 审核 |
| 代码资产安全 | 预览执行恶意代码 | 浏览器 iframe 沙箱（不在 Node 执行）、CSP、导入白名单、禁用模式、watchdog、内部限定 |
| 范围膨胀 | 做不完 | 只做按钮垂直切片；布局不做自由拖拽 |
| 迁移成本 | 旧资产不可用 | legacy 格式 + 转换工具 + 双读一段时间 |
| 快照存储增长 | 磁盘/成本 | WebP、thumb/full、版本保留策略、清理任务 |

## 18. 已知限制（v1 接受）

- 静态图片不能可靠还原 hover / 滚动 / 过渡 / 弹簧效果；推断状态必须人工确认，多帧/GIF/短视频放 v2。
- v1 不支持字体文件和图片资产；只能使用系统字体、Token 和 data URI 占位图，视觉还原有上限。
- 布局是 slots + 断点，不是自由画布；重叠、绝对定位、复杂响应式重排做不了。
- 预览 iframe 仍会执行资产 JS；CSP + sandbox + watchdog 降低风险，但不是绝对隔离。
- v1 不是 Figma 式可视化编辑器：没有自由拖拽、吸附、标尺、图层树；画布提供选中、状态预览、Token 控件、AI 指令和代码编辑。直接操作放 v2。
- AI patch 的作用域是「上下文 + diff 审核」，不是文件/节点级硬隔离。
- 对比度检查只覆盖 Token 和简单声明，不覆盖任意 Tailwind 类的语义。
- v1 的 hover/focus/disabled 状态是「快照预览 + AI/代码编辑」，不是画布上的状态编排器；选中状态直接拖控件调参放 v2。
- Tailwind utilities 是全局类名；复制 CSS 可能受宿主 Tailwind 版本影响，React 导出才是主路径。
- 旧 component/animation 转资产包是 best-effort，不保证和原实现等价。
- 当前按内部单用户/小团队设计；多人协作、评论、权限未设计。
- Registry / CLI 安装需要内网可达或短期签名 URL；不能把 READ KEY 放进安装命令。

## 19. 待确认

1. 是否确认「内部自用 + Next/Tailwind 为主」？如果是多用户/任意栈，需要补权限模型和多框架导出。
2. 预览是否需要真实 JS 交互？当前方案支持 iframe 内 React hooks/点击，但禁止网络和外部资源；复杂动画/拖拽交互仍建议放 v2。
3. 布局是否需要自由拖拽？v1 建议 slots + 断点；自由画布放 v2。
4. 是否保留任何形式的审核/锁定？建议只对「对外发布」保留锁定，不对内部创作强制。
5. 快照存储放本地还是对象存储？需要确认部署环境。

## 20. Phase 0 实施记录（2026-10-21）

已完成的最小垂直切片：

- `apps/api/src/modules/design/preview/preview-compiler.service.ts`：资产包校验、Tailwind 4 编译、esbuild browser bundle、CSP iframe HTML。
- `apps/api/src/modules/design/preview/preview-snapshot.service.ts`：Playwright 固定视口/状态截图。
- `GET /design/preview/sample` 与 `GET /design/preview/sample/snapshot`：内置玻璃按钮包。
- `/studio`：实时 iframe、设备切换、data-part 选中回传、源码复制、Playwright 快照。
- `PreviewCompileService` / `PreviewSnapshotService` 单测：编译通过、路径穿越/网络代码拒绝、Playwright 快照尺寸正确；API 全量 581 个测试通过。

Phase 0 的已知边界：

- 编译服务暂时放在 API 进程内，Phase 1 抽到 `apps/design-renderer`；接口契约不变。
- Tailwind 类名优先读 `manifest.tailwindClasses`；自动扫描目前只覆盖静态 `className="..."`，Phase 1 要补 `cn()` / CVA / 模板字符串的静态扫描。
- iframe 仍执行 bundle；CSP + sandbox 已生效，watchdog 和 renderer 隔离在 Phase 1 补。

## 21. Phase 1 实施记录（2026-10-21）

已完成资产包持久化与资产库最小闭环：

- Prisma：DesignDocument 增加 format/subtype/description/whenToUse/source/favorite；DesignVersion 增加 format；新增 DesignAssetFile / DesignAssetTag / DesignAssetTagLink。
- 迁移：add_design_asset_packages、backfill_design_asset_format、fix_design_asset_format_backfill（旧 component/animation/layout 标 legacy，新资产包标 package）。
- API：`POST/GET /design/assets`、`GET /design/assets/:id`、`GET /design/assets/:id/preview`、`GET /design/assets/:id/export?format=json|react|css|html|registry|ai`、收藏/归档、`POST /design/assets/seed-sample`。
- 页面：`/library` 资产库，支持 tab、搜索、卡片、详情实时 iframe、React/CSS/Registry/AI 导出、收藏、创建示例按钮。
- 验证：API 581 个测试通过；web build 通过；Playwright e2e 验证卡片→详情→iframe 点击状态更新→React 导出；中文搜索返回正常。

Phase 1 已知边界：

- 库卡片目前是程序化占位缩略图，不是真实快照；详情页是真实 iframe 预览。快照缩略图在 Phase 2 补。
- 还不能在库里创建/编辑资产；“在工作台打开”暂时跳到 Phase 0 的示例工作台，未按资产 ID 打开。
- 样式 tab 还没有 token 资产；当前只展示 format='package' 的组件包。
- 版本历史、标签筛选、归档 UI、对外发布版本锁定未做。

## 22. Phase 2 实施记录（2026-10-21）

已完成资产快照、版本历史与库交互增强：

- PreviewSnapshot 增加 state/kind/format/width/height，唯一约束 version+viewport+state+kind。
- 新增 DesignAssetSnapshotService：编译资产 → Playwright desktop/default 快照 → Storage 落盘 → PreviewSnapshot 记录。
- 新增接口：`GET /design/assets/:id/cover`、`POST /design/assets/:id/snapshot`、`GET /design/assets/:id/versions`、`GET /design/assets/:id/versions/:versionId`、`GET /design/assets/:id/versions/:versionId/diff`。
- 资产库卡片改用真实快照封面；详情页可生成/重生成封面。
- 详情页新增版本历史、内容哈希、文件数、对比上一版的文件级 diff。
- 新增标签筛选与归档确认。

验证：

- 封面接口返回 1440×960 PNG；代理路径同样 200。
- Playwright e2e：卡片封面 naturalWidth=1440；卡片 → 详情 → iframe 按钮点击 0→1；版本历史可见；标签筛选后仍能恢复全部。
- API 583 tests passed；typecheck / lint / build 通过。

Phase 2 已知边界：

- 只生成 desktop/default 的 full 快照，没有 thumb；卡片直接加载 1440 宽 PNG（约 12KB，可接受）。
- 快照在 seed/详情按钮里同步生成，首轮 Playwright 启动约 10s；没有任务队列、没有“生成中”状态轮询。
- 版本历史只读，没有恢复/发布/回滚按钮；版本对比是文件级内容对比，不是 AST/行级 diff。
- 没有创建/复制/fork 表单；归档没有反归档 UI。
- 标签筛选基于当前已加载资产的标签并集，不是独立标签索引。

## 23. Phase 2 复查修正（2026-10-21）

- 预览编译增加 import 白名单：只允许 React/ReactDOM/clsx/CVA/tailwind-merge/lucide-react 和包内相对导入；拒绝 fs、@/、动态 import、越出包目录的 ../、export ... from 外部包。
- 禁止 dangerouslySetInnerHTML、javascript:、vbscript:、document.write、new Worker、CSS @import、data:text/html。
- 编译器把 esbuild/Tailwind 失败包装成 400，不再冒成 500。
- 创建资产增加 subtype/description/tags/file target/type/language 校验；P2002 转 409。
- 标签筛选前端按与后端一致的 slug 规则匹配，修复多词标签筛选不到的问题。
- 封面/收藏异步返回后只在当前选中资产仍是同一资产时覆盖详情，避免切换资产时被旧请求回写。
- 空结果区分「没有资产」和「筛选无匹配」，筛选时隐藏示例按钮。
- 新增 import 白名单/路径穿越单测和版本 diff 单测；API 全量 583 tests passed。

## 24. Token / Legacy 资产入库（2026-10-21）

- 资产库不再只查 format='package'；token 和 legacy 资产会出现在列表。
- “样式” tab 的 kind=theme 现在包含 theme / foundation / style_pack。
- token/legacy 摘要增加 palette：从 token 的 color 节点提取颜色；卡片直接显示色板。
- token 详情显示色板，不加载 iframe；代码 tab 为 CSS / JSON / AI。
- legacy 详情显示“旧格式资产，暂不支持实时预览”，代码 tab 只有 JSON。
- 生成封面、在工作台打开只对 package 资产显示；收藏/归档/版本历史对所有格式可用。
- token 导出支持 css / json / ai；legacy 支持 json / ai；package 保持 react/css/html/registry/ai/json。
- 版本 diff 对无文件的 token/legacy 版本回退到 content.json 内容对比。
- 验证：样式 tab 打开靛蓝商务，色板可见、CSS 导出包含 --color-primary；切回组件 tab 后玻璃按钮 iframe 点击仍为 0→1；无 page/console error。

## 25. Phase 3 资产级工作台（2026-10-21）

- 资产库「在工作台打开」现在跳到 /studio?asset=<id>。
- /studio 支持两种模式：无 asset 参数保留 Phase 0 示例；有 asset 参数加载真实资产。
- 工作台加载资产详情、iframe 预览、文件列表和源码编辑器；保存时创建新版本，不覆盖旧版本。
- 新增 POST /design/assets/:idOrSlug/versions：校验 import/路径、编译、计算 contentHash、基于 latest 版本创建 vN+1、写文件、更新 currentPublishedVersionId，并生成新封面。
- 保存前校验 manifest.files 与文件列表；contentHash 相同直接返回，不制造空版本；P2002 返回 409。
- 验证：玻璃按钮 v2 文案「立即开始」→ 编辑器改成「马上开始」→ 保存 v3 → iframe 预览更新，无 page/console error。
- API 583 tests passed；typecheck / lint / build 通过。

Phase 3 当前边界：

- 还没有 AI 对话、草稿工作副本、Patch 候选；目前是源码编辑直接保存新版本。
- 不能编辑 manifest 元数据、标签、依赖或状态；只能编辑文件正文。
- 不支持 token/legacy 资产编辑，只显示只读说明和色板。
- 没有删除文件/新增文件 UI；文件列表来自当前资产。
- 保存会同步等待封面快照，首次 Playwright 启动约 10 秒。
- 没有撤销、恢复版本、发布/草稿切换 UI。

## 26. AI 对话草稿（2026-10-21）

- 新增表：DesignDraftFile、DesignDraftSnapshot、StudioMessage；ChangeSession 增加 documentId/title/messages。
- 新增接口：
  - POST /design/studio/sessions
  - GET /design/studio/sessions/:id
  - POST /design/studio/sessions/:id/messages
  - GET /design/studio/sessions/:id/preview
  - POST /design/studio/sessions/:id/save
  - POST /design/studio/candidates/:id/apply
- AI 输入包含 manifest、当前草稿文件、用户请求和最近对话；模型只允许返回 replace_file 操作。
- 服务端对 AI 补丁做路径存在性、import 白名单和完整编译校验，失败不会写入草稿。
- 候选补丁保存为 CandidateProposal；用户点「应用到草稿」后才写 DesignDraftFile，并生成草稿快照。
- 工作台打开 package 资产时会复用/创建开放会话，并加载草稿文件和草稿预览；保存新版本时优先保存草稿。
- 验证：AI 要求「把按钮文案改成开始」→ 生成补丁 → 应用到草稿 → iframe 显示「开始」→ 保存生成 v5，无 page/console error。
- API 583 tests passed；API/Web typecheck、lint、build 通过。

Phase 3 AI 当前边界：

- 同步请求，没有 SSE/流式输出；AI 调用期间前端只有一个 loading。
- 只支持 replace_file 全文替换；不支持新增/删除文件、行级 patch、manifest 编辑。
- 前端只展示 changedPaths 和摘要，没有并排代码 diff。
- 已应用补丁没有撤销/拒绝 UI；DesignDraftSnapshot 已落库，但还没有恢复入口。
- 没有流式 token、停止生成、重试、成本预览。
- 一个资产复用一个 open session；没有会话列表/关闭/清理。
- 保存仍同步等待封面快照；AI 调用依赖系统设置里的 Provider。

## 27. 流式输出与补丁 Diff（2026-10-21）

- 新增 POST /design/studio/sessions/:id/messages/stream，SSE 事件：status / delta / candidate / done / error。
- DesignAgentService 增加 streamAssetPatch，使用 Anthropic messages.stream 逐段回调；非流式 generateAssetPatch 保留。
- CandidateProposal.structuredDiff 现在保存 files: [{path,before,after}]；候选接口返回 diff。
- 工作台聊天改为 fetch ReadableStream 解析 SSE：实时显示 AI 生成内容，收到 candidate 后展示候选补丁和并排 diff。
- 验证：SSE 直连收到 51 个 delta + status/candidate/done；浏览器通过 Next 代理发送「把按钮文案改成继续」→ 应用补丁 → iframe 显示「继续 0」；diff 面板可见；无 page/console error。
- API/Web typecheck、lint、build 通过。

当前边界：

- 流式内容是原始 JSON 片段，不是可读的自然语言 token；前端用等宽小字展示“生成中”。
- 没有停止生成、重试、断线重连；SSE 请求失败只保留错误消息。
- diff 是整文件 before/after 文本，不是行级 diff；大文件会有较长滚动区域。
- 没有拒绝补丁、撤销已应用补丁、从草稿快照恢复的 UI。
- 会话仍是一个资产一个 open session；没有会话列表/关闭。

## 28. 停止生成 / 拒绝 / 撤销（2026-10-21）

- SSE 请求增加 AbortController：浏览器停止时 abort fetch；API 监听 req close/aborted + res close，取消 Anthropic stream。
- 生成被停止时写入 assistant 消息 status='cancelled'，内容「生成已停止」。
- 新增 POST /design/studio/candidates/:id/reject：计划态补丁标记 rejected，对应消息标记 rejected；已应用补丁不能直接拒绝。
- 新增 POST /design/studio/sessions/:id/undo：从最近两个 DesignDraftSnapshot 恢复上一个草稿状态，创建新的撤销快照，并把最近 applied 候选标记 undone。
- 工作台聊天增加「停止生成」「拒绝」「撤销到上一版」按钮。
- 验证：
  - 浏览器 abort 后会话出现 assistant/cancelled「生成已停止」。
  - undo 后草稿从「继续」恢复到「开始」，候选状态变 undone。
  - reject 后候选状态变 rejected。
- API/Web typecheck、lint、build 通过。

当前边界：

- 撤销是单步快照回退，没有多级历史 UI；再次撤销可能表现成 redo。
- 拒绝/撤销没有二次确认；撤销只回退草稿，不会回滚已保存的正式版本。
- 停止生成后没有自动重试按钮。
- SSE 断线只结束当前请求，没有 Last-Event-ID 重连。

## 29. 重试与丢弃草稿（2026-10-21）

- 新增 POST /design/studio/sessions/:id/messages/retry/stream：复用最后一条 user 消息重新跑 AI，不重复插入 user 消息。
- 新增 POST /design/studio/sessions/:id/discard：从当前正式版本恢复草稿文件，创建快照，把 planned/applied 候选标记 discarded，返回草稿预览。
- 工作台聊天增加「重新生成」和「丢弃草稿」；丢弃有二次确认。
- 验证：
  - 重试 SSE 返回 status/delta/candidate/done，user 消息数量不变。
  - 丢弃后草稿回到正式版本，候选消失，预览更新。
- API/Web typecheck、lint、build 通过；API 583 tests passed。

当前边界：

- 重试只复用最后一条 user 消息，不能选择历史消息重试。
- 丢弃会丢掉所有未保存草稿和候选，没有回收站/恢复入口。
- 没有会话关闭、会话列表或自动过期清理。

## 30. 会话列表 / 关闭 / 快照恢复（2026-10-21）

- 新增 GET /design/studio/sessions?assetId=，返回会话、消息数、草稿 revision。
- 新增 POST /design/studio/sessions/:id/close，关闭会话并关闭草稿；下次创建会开新会话。
- 新增 GET /design/studio/sessions/:id/snapshots 和 POST /design/studio/sessions/:id/snapshots/:revision/restore。
- 工作台 AI 卡片增加 open 会话选择器、关闭按钮；关闭后自动创建新会话。
- 侧栏增加「草稿历史」，展示最近 6 个快照 revision、时间和文件数，可一键恢复。
- 验证：
  - 列表返回 1 个 open session、22 条消息、revision 11。
  - 快照列表返回 11/10/9...，恢复 API 201。
  - 浏览器关闭会话后自动创建新会话，无 page error。
- API/Web typecheck、lint、build 通过；API 583 tests passed。

当前边界：

- 选择器只显示 open 会话；closed 会话只能通过 API 查看。
- 恢复快照没有二次确认，恢复后旧候选统一标记 undone。
- 草稿历史只显示最近 6 个，没有完整分页。
- 没有会话删除、自动过期、回收站。

## 31. 行级 Diff（2026-10-21）

- 新增前端 line-diff 工具：LCS 行级 diff、3 行上下文、hunk 合并、行号、+/- 统计。
- 超大文件（行数乘积 > 1,000,000）退化为整段删除/新增，避免 DP 内存爆炸。
- 候选补丁的「查看 diff」从整文件并排改为 unified hunk 展示：
  - @@ -beforeStart,beforeCount +afterStart,afterCount @@
  - 绿色新增行、红色删除行、上下文行
  - 文件级 +added / -removed
- 验证：line-diff 单测 4 个通过；浏览器打开候选 diff 可见 1 个 hunk、+/- 行，无 page error。
- Web lint/typecheck 通过。

当前边界：

- 是行级 diff，不是字符级/语法树 diff。
- 没有折叠未变更行以外的交互（比如展开完整文件）。
- 超大文件退化为整段替换，可能显示很多行。
- 没有 diff 复制/下载。

## 32. Token 编辑器（2026-10-21）

- 新增 POST /design/assets/:idOrSlug/token-versions：用 validateDesignContent 校验 Token 文档，创建不可变新版本。
- 工作台 token 资产进入 TokenEditor：
  - JSON 编辑、格式化、保存新版本
  - 实时显示解析错误
  - 色板侧栏
  - 版本说明
- 资产库 token 详情「编辑 Token」直接进入编辑器。
- 验证：palette-indigo v3 主色改为 #0ea5e9 → 保存 v4 → 编辑器内容更新、色板更新、无 page error。
- API/Web typecheck、lint、build 通过；API 583 tests passed。

当前边界：

- Token 编辑器是 JSON 编辑，不是结构化表单；没有逐个 token 的输入控件、颜色选择器或对比度检查。
- Token AI 修改还没接。
- 保存 Token 不会自动重建依赖它的组件/布局，也不会更新它们的钉住版本。
- Token 资产没有封面/iframe 预览，只用色板辅助。
- Legacy 资产仍是只读。

## 33. Token AI 修改与对比度门禁（2026-10-21）

- 新增 POST /design/assets/:idOrSlug/token-ai：AI 返回完整 Token 文档，服务端用 validateDesignContent 校验。
- 新增 POST /design/assets/:idOrSlug/token-contrast：检查四组语义颜色：
  - color.text / color.page
  - color.text / color.surface
  - color.on-primary / color.primary
  - color.muted / color.surface
- Token 保存前执行对比度门禁：fail 直接 400；undeterminable 允许保存但返回风险信息。
- TokenEditor 增加：
  - AI 输入框「生成 Token 修改」
  - 对比度检查按钮和检查结果
  - AI 修改后自动刷新色板/对比度
- 验证：palette-indigo 输入「把主色改深一点并保持对比度」→ AI 返回 #1d4ed8 → 对比度通过 → 保存 v6，无 page error。
- API 583 tests passed；API/Web typecheck、lint、build 通过。

当前边界：

- Token AI 是同步请求，不是流式；返回完整文档而不是 token 级 patch。
- 对比度只检查四组语义颜色，不做所有前景/背景组合，也不做图片背景。
- 别名会解析到字面量；带透明度背景判为 undeterminable。
- Token 保存不会自动重建依赖组件，也不会更新它们的钉住版本。
- Token 编辑器仍是 JSON 编辑，不是结构化表单。

## 34. Token 依赖提示与重建（2026-10-21）

- 新增 GET /design/assets/:idOrSlug/dependents：扫描设计文档当前版本的 dependencies，返回钉住该 Token 的资产和是否过期。
- 新增 POST /design/assets/:idOrSlug/dependents/rebuild：把旧依赖版本改成当前 Token 版本，校验后创建依赖资产的新版本。
- TokenEditor 增加「依赖资产」卡片：
  - 显示依赖资产名称/kind/版本
  - 旧 Token 标记
  - 「同步旧依赖」按钮
  - 无依赖时显示空状态
- 验证：palette-indigo 当前无依赖，接口返回空列表；rebuild 返回 updated=0, skipped=2（不依赖该 Token 的文档），无 page error。
- API/Web typecheck、lint、build 通过；API 583 tests passed。

当前边界：

- 依赖扫描基于当前版本的 content.dependencies，不覆盖 package manifest 的 assetDependencies。
- 重建只更新依赖版本并创建新版本，不重新渲染/截图，也不检查视觉回归。
- 重建会一次性更新所有旧依赖，没有逐个选择或 dry-run UI。
- 依赖列表不缓存，每次进入 TokenEditor 都会扫描文档。

## 35. Token 结构化颜色编辑器（2026-10-21）

- 新增 token-colors 工具：
  - collectColorTokens：递归提取 color token
  - setColorTokenValue：不可变更新嵌套 token
  - colorInputValue：把 #rgb / #rrggbb 映射到原生颜色输入
- TokenEditor 增加「颜色 Token」卡片：
  - 每个 color token 一行：原生颜色选择器 + 文本输入
  - 修改任一输入会同步更新 JSON 编辑器
  - 非 hex / rgba / hsl 只允许文本输入
- 新增 3 个 token-colors 单测；Web 测试 71 passed。
- 验证：palette-indigo 显示 8 个颜色输入；把主色改为 #dc2626 后 JSON 同步；无 page error。
- Web lint/typecheck 通过。

当前边界：

- 结构化表单只覆盖 color token；dimension/shadow/border 等仍只能编辑 JSON。
- 原生颜色输入不支持 alpha、hsl、别名；这些只能用文本输入。
- 没有「添加/删除 token」的结构化入口。
- 颜色选择器不会实时跑对比度，需要点「检查」。

## 36. 导航收尾（2026-10-21）

- 侧边栏移除「样式实验室」「设计运营台」入口。
- 新增独立「设计」分组：资产库、工作台。
- 资源分组只保留资源/上传/任务中心。
- 旧路由 /style-lab、/design-library 仍可直接访问，暂不删除页面。
- Web lint/typecheck 通过。

## 37. 复查后补强（2026-10-22）

- Tailwind 类名扫描从静态 className 扩展到 cn / clsx / classNames / twMerge / cva 里的字符串，以及 className 模板字符串的静态前缀。
- 预览编译增加 20 秒超时；Playwright 快照页默认超时 15 秒。
- DesignAssetSnapshotService 增加串行队列，避免并发请求同时启动多个浏览器。
- DesignDraftSnapshot 增加 (draftId, revision) 唯一索引，防止并发产生重复 revision。
- AI 候选补丁增加 supersede 与草稿快照时间校验，避免旧补丁覆盖新草稿。
- 工作台增加 draftDirty：本地未同步修改时禁用 AI 发送/重试/应用、撤销/恢复快照、切换/关闭会话。
- 离开工作台时 abort 当前 SSE。
- Token 依赖查询/重建只扫描 published 文档。
- 新增 Tailwind scanner 3 个单测、DesignStudioService 2 个单测、对比度 3 个单测。
- 验证：API 591 tests passed；Web 71 tests passed；API/Web typecheck、lint、build 通过。

## 38. 快照 Job 队列与 Worker（2026-10-22）

- 新增 PreviewSnapshotJob 表：versionId/viewport/state/kind 唯一，状态 pending/running/succeeded/failed，带 attempts、leaseUntil、workerId、error。
- 创建资产和保存版本在同一事务里入队；API 不再同步等待 Playwright。
- 新增 PreviewSnapshotWorker：worker 进程设置 SNAPSHOT_JOB_WORKER=true 后启动，claim job、生成快照、写 storage、更新 job。
- job 支持 lease 超时回收、退避重试、最大次数失败。
- 快照存储 key 改为稳定版本路径，artifactHash 只作为元数据，避免重试产生孤儿文件。
- 资产摘要/详情增加 coverStatus、coverError；前端在封面生成中显示占位并轮询，失败显示失败状态。
- 验证：保存资产后接口立即返回 pending，worker 经历 running → succeeded；封面 URL 可用。
- API/Web typecheck、lint、build 通过。

当前边界：

- renderer 代码仍在 worker 进程内，worker 同时持有 Prisma/storage；还不是独立无状态 design-renderer 服务。
- SQLite job 队列只适合单 worker；后续换 Postgres/Redis 才能多 worker。
- 没有 job 管理 UI、死信队列、指标面板。
- 旧版本封面文件没有自动清理。
- worker start:dev 仍然依赖 API dist 的构建产物。

## 39. 独立 Design Renderer（2026-10-22）

- 新增 apps/design-renderer：
  - GET /health
  - POST /internal/compile
  - POST /internal/screenshot
  - 无 Prisma、无 storage、无 AI key
  - 可选 x-design-renderer-key
  - 8MB 请求体上限
- 新增 packages/design-preview，API 与 renderer 共用 PreviewCompileService / PreviewSnapshotService / Tailwind scanner。
- 新增 PreviewRendererClient：worker 设置 DESIGN_RENDERER_URL 后通过 HTTP 调 renderer；未配置时保留本地 fallback（测试/开发）。
- .env.example 增加 DESIGN_RENDERER_URL / DESIGN_RENDERER_KEY。
- 根 dev 脚本增加 renderer（3002），predev 依次构建 API、worker、renderer。
- 验证：
  - renderer /compile 返回 206KB HTML、10KB CSS、194KB JS。
  - /screenshot 返回 11.8KB PNG。
  - 保存资产后 worker running → succeeded，封面可用。
- API/Web typecheck、lint、build 通过；API 591 tests passed；Web 71 tests passed。

当前边界：

- API 自己的预览/校验仍使用本地 PreviewCompileService；renderer 目前只用于 worker 快照。
- renderer 已改为 import @aurum/design-preview；API 仍保留本地编译用于详情预览/保存校验。
- renderer 鉴权 key 在单机默认可为空；生产必须配置。
- 没有进程 supervisor/自动重启、metrics、请求队列。
- worker 仍持有 Prisma/storage；renderer 才是无状态部分。

## 40. API 编译切换到 Renderer + 共享包（2026-10-22）

- 新增 packages/design-preview：编译、快照、Tailwind scanner、sample 统一由 API 和 renderer 共用。
- API 的 PreviewCompileService / PreviewSnapshotService 改为装饰器包装：
  - 配置 DESIGN_RENDERER_URL 时通过 HTTP 调 renderer
  - 未配置时回退本地共享编译/截图（测试/离线）
  - renderer 进程不导入 API，避免递归
- API 的 /preview/sample/snapshot 也改走 renderer，renderer 停止时返回 503。
- API 移除 React / react-dom / esbuild / @tailwindcss/node 直接依赖；保留 tailwindcss 供无 renderer 的本地回退。
- 验证：
  - renderer 停止时 GET /assets/glass-button/preview 返回 503 Design renderer 不可用
  - renderer 恢复后同一接口 200
  - 保存资产：pending → running → succeeded，封面可用
- API 591 tests passed；Web 71 tests passed；API/Web/Renderer/Worker typecheck、lint、build 通过。

当前边界：

- Renderer 默认绑定 127.0.0.1；容器/多机时通过 DESIGN_RENDERER_HOST=0.0.0.0 放开，
  此时必须同时设置 DESIGN_RENDERER_KEY（renderer 与 API 使用同一个值），否则 renderer 拒绝启动。
- API 在未配置 renderer 时仍有本地编译 fallback，生产应强制配置。
- worker 仍持有 Prisma/storage；renderer 无 DB/storage。
- SQLite job 队列仍是单 worker。
- 没有 renderer/worker supervisor、metrics、旧封面清理。

## 41. 最终复查修复（2026-10-22）

- 修复 API PreviewCompileService 包装未真正生效的问题。
- 新增 API PreviewSnapshotService 包装，/preview/sample/snapshot 也走 renderer；renderer 停止时返回 503。
- Renderer 默认绑定 127.0.0.1，并增加 server error 日志。
- 修复资产库手动生成封面时错误地把 hasCover 置 true 的 UI bug。
- 修复封面轮询结果可能覆盖用户刚切换资产的问题。
- 修复 job 重新 claim 时保留旧 error 的问题。
- DESIGN_RENDERER_URL 改为 127.0.0.1，和 renderer 绑定地址一致。
- 验证：renderer 停止时 API 编译/示例快照 503；恢复后 200；全链路保存 pending → running → succeeded。
- API 591 tests passed；Web 71 tests passed；API/Web/Renderer/Worker typecheck、lint、build 通过。
