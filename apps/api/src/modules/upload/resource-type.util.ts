import { ResourceType } from '../../common/constants/enums';

/**
 * MIME 类型 -> 资源类型 映射
 * 用于根据真实 MIME（由 file-type 识别）推断资源大类
 */
const MIME_TO_TYPE: Record<string, string> = {
  // 图片
  'image/jpeg': ResourceType.image,
  'image/png': ResourceType.image,
  'image/webp': ResourceType.image,
  'image/gif': ResourceType.image,
  'image/svg+xml': ResourceType.image,
  'image/bmp': ResourceType.image,
  'image/tiff': ResourceType.image,
  'image/x-icon': ResourceType.image,
  // 视频
  'video/mp4': ResourceType.video,
  'video/quicktime': ResourceType.video,
  'video/webm': ResourceType.video,
  'video/x-matroska': ResourceType.video,
  'video/x-msvideo': ResourceType.video,
  // 音频
  'audio/mpeg': ResourceType.audio,
  'audio/wav': ResourceType.audio,
  'audio/x-wav': ResourceType.audio,
  'audio/ogg': ResourceType.audio,
  'audio/flac': ResourceType.audio,
  'audio/aac': ResourceType.audio,
  'audio/x-m4a': ResourceType.audio,
  // 文档（PDF + Office，Office 第一版只记录元数据）
  'application/pdf': ResourceType.document,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ResourceType.document,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    ResourceType.document,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ResourceType.document,
  'application/msword': ResourceType.document,
  'application/vnd.ms-powerpoint': ResourceType.document,
  'application/vnd.ms-excel': ResourceType.document,
  // 文本
  'text/plain': ResourceType.text,
  'text/markdown': ResourceType.text,
  'application/json': ResourceType.text,
  'text/csv': ResourceType.text,
  'application/xml': ResourceType.text,
  'text/xml': ResourceType.text,
  'text/html': ResourceType.text,
  'application/javascript': ResourceType.text,
  'text/css': ResourceType.text,
  'application/yaml': ResourceType.text,
  // 压缩包
  'application/zip': ResourceType.archive,
  'application/x-rar-compressed': ResourceType.archive,
  'application/x-7z-compressed': ResourceType.archive,
  'application/x-tar': ResourceType.archive,
  'application/gzip': ResourceType.archive,
  'application/x-bzip2': ResourceType.archive,
  // 3D 模型
  'model/gltf-binary': ResourceType.model3d,
  'model/gltf+json': ResourceType.model3d,
  // 字体
  'font/ttf': ResourceType.font,
  'font/otf': ResourceType.font,
  'font/woff': ResourceType.font,
  'font/woff2': ResourceType.font,
};

/**
 * 扩展名 -> 资源类型 映射（MIME 未识别时兜底）
 */
const EXT_TO_TYPE: Record<string, string> = {
  jpg: ResourceType.image,
  jpeg: ResourceType.image,
  png: ResourceType.image,
  webp: ResourceType.image,
  gif: ResourceType.image,
  svg: ResourceType.image,
  bmp: ResourceType.image,
  tiff: ResourceType.image,
  ico: ResourceType.image,
  mp4: ResourceType.video,
  mov: ResourceType.video,
  webm: ResourceType.video,
  mkv: ResourceType.video,
  avi: ResourceType.video,
  mp3: ResourceType.audio,
  wav: ResourceType.audio,
  ogg: ResourceType.audio,
  flac: ResourceType.audio,
  aac: ResourceType.audio,
  m4a: ResourceType.audio,
  pdf: ResourceType.document,
  docx: ResourceType.document,
  pptx: ResourceType.document,
  xlsx: ResourceType.document,
  doc: ResourceType.document,
  ppt: ResourceType.document,
  xls: ResourceType.document,
  txt: ResourceType.text,
  md: ResourceType.text,
  json: ResourceType.text,
  csv: ResourceType.text,
  xml: ResourceType.text,
  html: ResourceType.text,
  js: ResourceType.text,
  ts: ResourceType.text,
  css: ResourceType.text,
  yaml: ResourceType.text,
  yml: ResourceType.text,
  zip: ResourceType.archive,
  rar: ResourceType.archive,
  '7z': ResourceType.archive,
  tar: ResourceType.archive,
  gz: ResourceType.archive,
  bz2: ResourceType.archive,
  glb: ResourceType.model3d,
  gltf: ResourceType.model3d,
  fbx: ResourceType.model3d,
  obj: ResourceType.model3d,
  ttf: ResourceType.font,
  otf: ResourceType.font,
  woff: ResourceType.font,
  woff2: ResourceType.font,
};

/**
 * 根据真实 MIME 和扩展名推断资源类型
 * 优先用 MIME，未识别时用扩展名兜底，仍未知归 other
 */
export function inferResourceType(mimeType: string, extension: string): string {
  if (mimeType && MIME_TO_TYPE[mimeType]) {
    return MIME_TO_TYPE[mimeType];
  }
  const ext = extension.toLowerCase();
  if (ext && EXT_TO_TYPE[ext]) {
    return EXT_TO_TYPE[ext];
  }
  return ResourceType.other;
}
