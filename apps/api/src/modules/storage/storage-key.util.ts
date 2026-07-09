/**
 * 文件角色 -> 存储目录名映射
 */
const ROLE_DIR_MAP: Record<string, string> = {
  original: 'originals',
  thumbnail: 'thumbnails',
  preview: 'previews',
  extracted_text: 'extracted-text',
  transcode: 'transcodes',
};

/**
 * 文件角色 -> 文件名后缀映射
 * extracted_text 无后缀，直接用 hash 命名
 */
const ROLE_SUFFIX_MAP: Record<string, string> = {
  original: 'original',
  thumbnail: 'thumb',
  preview: 'preview',
  extracted_text: '',
  transcode: 'transcode',
};

/**
 * 生成正式存储 key
 *
 * 规则：{role-dir}/{hash[0:2]}/{hash[2:4]}/{hash}{.suffix}{.variant}.{ext}
 * 用 hash 前两位分片，避免单目录文件过多。
 *
 * 示例（hash = abcdef1234567890）：
 *   original/ab/cd/abcdef1234567890.original.png
 *   thumbnails/ab/cd/abcdef1234567890.thumb.webp
 *   extracted-text/ab/cd/abcdef1234567890.txt
 *
 * @param role 文件角色
 * @param hash 文件 SHA-256（小写十六进制）
 * @param variant 变体标识（如 PDF 多页缩略图 page-1），可选
 * @param extension 文件扩展名（不含点），可选
 */
export function generateStorageKey(
  role: string,
  hash: string,
  variant?: string,
  extension?: string,
): string {
  if (!hash || hash.length < 4) {
    throw new Error(`Invalid hash for storage key: must be at least 4 characters`);
  }
  const dir = ROLE_DIR_MAP[role];
  if (!dir) {
    throw new Error(`Unknown file role: ${role}`);
  }
  const prefix = `${hash.slice(0, 2)}/${hash.slice(2, 4)}`;
  const suffix = ROLE_SUFFIX_MAP[role];
  const variantPart = variant ? `.${variant}` : '';
  const fileBase = suffix ? `${hash}.${suffix}` : hash;
  const ext = extension ? `.${extension}` : '';
  return `${dir}/${prefix}/${fileBase}${variantPart}${ext}`;
}
