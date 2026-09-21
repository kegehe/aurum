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

/** 资源类型图标（lucide-react 图标名） */
export const RESOURCE_TYPE_ICONS: Record<ResourceType, string> = {
  [ResourceType.image]: 'Image',
  [ResourceType.video]: 'Video',
  [ResourceType.audio]: 'Music',
  [ResourceType.text]: 'FileText',
  [ResourceType.document]: 'File',
  [ResourceType.archive]: 'Archive',
  [ResourceType.model3d]: 'Box',
  [ResourceType.font]: 'Type',
  [ResourceType.game_asset]: 'Gamepad2',
  [ResourceType.other]: 'FileQuestion',
};

/** 资源类型徽章颜色（Tailwind CSS 类） */
export const RESOURCE_TYPE_COLORS: Record<
  ResourceType,
  { bg: string; text: string; border: string }
> = {
  [ResourceType.image]: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-300' },
  [ResourceType.video]: {
    bg: 'bg-purple-100',
    text: 'text-purple-700',
    border: 'border-purple-300',
  },
  [ResourceType.audio]: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-300' },
  [ResourceType.text]: { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border-gray-300' },
  [ResourceType.document]: {
    bg: 'bg-orange-100',
    text: 'text-orange-700',
    border: 'border-orange-300',
  },
  [ResourceType.archive]: {
    bg: 'bg-yellow-100',
    text: 'text-yellow-700',
    border: 'border-yellow-300',
  },
  [ResourceType.model3d]: { bg: 'bg-pink-100', text: 'text-pink-700', border: 'border-pink-300' },
  [ResourceType.font]: {
    bg: 'bg-indigo-100',
    text: 'text-indigo-700',
    border: 'border-indigo-300',
  },
  [ResourceType.game_asset]: { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-300' },
  [ResourceType.other]: { bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300' },
};

/** 处理状态中文标签 */
export const PROCESSING_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '处理失败',
};

/** 获取模式中文标签 */
export const ACQUISITION_MODE_LABELS: Record<string, string> = {
  local_upload: '本地上传',
  link_only: '外部链接',
  metadata_only: '仅元数据',
  archive_snapshot: '网页快照',
  mirror_file: '文件镜像',
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
      { href: '/style-lab', label: '样式实验室', icon: 'Palette' },
      { href: '/design-library', label: '设计运营台', icon: 'Palette' },
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
      { href: '/settings', label: '系统设置', icon: 'Settings' },
    ],
  },
] as const;
