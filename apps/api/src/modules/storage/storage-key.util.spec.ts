import { describe, expect, it } from 'vitest';
import { FileRole } from '../../common/constants/enums';
import { ROLE_DIR_MAP, ROLE_SUFFIX_MAP, generateStorageKey } from './storage-key.util';

const HASH = 'a'.repeat(64);

/**
 * 这组用例存在的理由：设计运营台的受控渲染器曾经传 'design-preview' /
 * 'design-diff' 两个未注册的 role，真实驱动下必然抛 Unknown file role，
 * 但渲染器的 spec 自己伪造了 generateKey，缺陷被隐藏到运行时。
 * 所以这里必须走**真实**的 generateStorageKey，并按 FileRole 全量覆盖。
 */
describe('generateStorageKey role registry', () => {
  it('registers a directory and a suffix for every FileRole member', () => {
    for (const role of Object.values(FileRole)) {
      expect(ROLE_DIR_MAP[role], `ROLE_DIR_MAP 缺少 role: ${role}`).toBeTruthy();
      expect(ROLE_SUFFIX_MAP[role], `ROLE_SUFFIX_MAP 缺少 role: ${role}`).toBeDefined();
    }
  });

  it('only lets the documented no-suffix role produce a bare hash filename', () => {
    // ROLE_SUFFIX_MAP 缺条目时不抛错，只会静默丢后缀段，比缺 dir 更隐蔽。
    // 因此把「无后缀」限定为 extracted_text 这一个显式例外。
    for (const role of Object.values(FileRole)) {
      if (role === FileRole.extracted_text) continue;
      expect(ROLE_SUFFIX_MAP[role], `role ${role} 不应是无后缀角色`).toBeTruthy();
    }
  });

  it('generates sharded keys for every FileRole member', () => {
    for (const role of Object.values(FileRole)) {
      const key = generateStorageKey(role, HASH, 'variant-1', 'png');
      const suffix = ROLE_SUFFIX_MAP[role];
      const fileBase = suffix ? `${HASH}.${suffix}` : HASH;
      expect(key, `role ${role} 生成的 key 形态不正确`).toBe(
        `${ROLE_DIR_MAP[role]}/aa/aa/${fileBase}.variant-1.png`,
      );
    }
  });

  it('resolves the design console render roles to their own directories', () => {
    expect(generateStorageKey(FileRole.design_preview, HASH, 'c1-desktop', 'png')).toBe(
      `design-previews/aa/aa/${HASH}.preview.c1-desktop.png`,
    );
    expect(generateStorageKey(FileRole.design_diff, HASH, 'c1-desktop', 'png')).toBe(
      `design-diffs/aa/aa/${HASH}.diff.c1-desktop.png`,
    );
  });

  it('rejects unknown roles and short hashes', () => {
    expect(() => generateStorageKey('design-thumbnail', HASH, 'v1', 'png')).toThrow(
      'Unknown file role',
    );
    expect(() => generateStorageKey(FileRole.original, 'abc', 'v1', 'png')).toThrow(
      'Invalid hash for storage key',
    );
  });
});
