import { ResourceType } from '@aurum/shared-types';

/** 资源类型中文标签 */
export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  [ResourceType.image]: '图片',
  [ResourceType.video]: '视频',
  [ResourceType.audio]: '音频',
  [ResourceType.text]: '文本',
  [ResourceType.document]: '文档',
  [ResourceType.archive]: '压缩包',
  [ResourceType.model3d]: '3D 模型',
  [ResourceType.font]: '字体',
  [ResourceType.game_asset]: '游戏素材',
  [ResourceType.other]: '其他',
};

/** 处理状态中文标签 */
export const PROCESSING_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '处理失败',
};

/** 来源类型中文标签 */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  link_metadata: '链接元数据',
  github: 'GitHub',
  rss: 'RSS',
  civitai: 'Civitai',
  custom: '自定义',
};

/** 定位器类型中文标签 */
export const LOCATOR_TYPE_LABELS: Record<string, string> = {
  page: '页面',
  download: '下载',
  api: 'API',
  mirror: '镜像',
  preview: '预览',
  favicon: '图标',
};

/** 导航菜单项 */
export const NAV_ITEMS = [
  {
    group: '概览',
    items: [{ href: '/dashboard', label: '仪表盘', icon: 'LayoutDashboard' }],
  },
  {
    group: '资源',
    items: [
      { href: '/resources', label: '资源库', icon: 'FolderOpen' },
      { href: '/upload', label: '上传', icon: 'Upload' },
      { href: '/import-link', label: '添加链接', icon: 'Link' },
      { href: '/imports', label: '任务中心', icon: 'Download' },
    ],
  },
  {
    group: '设计',
    items: [
      { href: '/design-library', label: 'AI 新建', icon: 'Sparkles' },
      { href: '/library', label: '资产库', icon: 'Library' },
      { href: '/studio', label: '工作台', icon: 'Wand2' },
      { href: '/style-lab', label: '样式实验室', icon: 'Palette' },
      { href: '/design-library/review', label: '审核台', icon: 'ClipboardCheck' },
    ],
  },
  {
    group: '管理',
    items: [{ href: '/sources', label: '来源管理', icon: 'Globe' }],
  },
  {
    group: '系统',
    items: [
      { href: '/trash', label: '回收站', icon: 'Trash2' },
      { href: '/ai-usage', label: 'AI 用量', icon: 'BarChart3' },
      { href: '/consistency', label: '一致性检查', icon: 'ShieldCheck' },
      { href: '/settings', label: '系统设置', icon: 'Settings' },
    ],
  },
] as const;

/** AI 调用来源中文标签（后端 AiFeature） */
export const AI_FEATURE_LABELS: Record<string, string> = {
  'style.analyze': '样式分析',
  'style.variations': '布局变体',
  'design.generate': '设计生成',
  'design.repair': '设计修复',
};

/** AI 失败分类中文标签 */
export const AI_ERROR_KIND_LABELS: Record<string, string> = {
  connectivity: '连接失败',
  rate_limit: '限流',
  auth: '鉴权失败',
  output: '输出异常',
  capability: '能力不支持',
  canceled: '已取消',
  unknown: '未知错误',
};
