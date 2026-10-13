/**
 * 文件角色 -> 存储目录名映射
 *
 * 对测试导出：role 缺失会抛错，但两张表必须同时注册——只补一张是静默失败
 * （见 ROLE_SUFFIX_MAP 注释），所以「两张表都覆盖 FileRole 每个成员」要能被断言。
 */
export const ROLE_DIR_MAP: Record<string, string> = {
  original: 'originals',
  thumbnail: 'thumbnails',
  preview: 'previews',
  extracted_text: 'extracted-text',
  transcode: 'transcodes',
  snapshot: 'snapshots',
  // 设计运营台的受控渲染产物。分成独立目录，便于按前缀做孤儿对账。
  'design-preview': 'design-previews',
  'design-diff': 'design-diffs',
};

/**
 * 文件角色 -> 文件名后缀映射
 *
 * extracted_text 是唯一的无后缀角色（空串是有意的）。
 *
 * 注意：与 ROLE_DIR_MAP 不同，这里缺条目**不会抛错**——`suffix ? ... : hash`
 * 会静默产出另一种 key 形态（丢掉后缀段）。所以新增 role 时两张表都要补，
 * 漏掉这一张的症状更隐蔽。测试按 FileRole 全量断言可覆盖。
 */
export const ROLE_SUFFIX_MAP: Record<string, string> = {
  original: 'original',
  thumbnail: 'thumb',
  preview: 'preview',
  extracted_text: '',
  transcode: 'transcode',
  snapshot: 'snapshot',
  'design-preview': 'preview',
  'design-diff': 'diff',
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
