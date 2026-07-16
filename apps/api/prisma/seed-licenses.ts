/**
 * 许可证种子数据
 *
 * 使用 upsert 按 spdxId 插入，幂等，不覆盖已有数据。
 * 运行方式：npx ts-node prisma/seed-licenses.ts
 * 或通过 Prisma seed 命令调用。
 */
import { PrismaClient } from '@prisma/client';

const LICENSES = [
  {
    spdxId: 'unknown',
    name: '未知许可',
    url: null,
    text: null,
    allowsCommercialUse: null,
    allowsRedistribution: null,
    allowsDerivatives: null,
    requiresAttribution: false,
    shareAlike: false,
  },
  {
    spdxId: 'CC0-1.0',
    name: 'CC0 1.0 Universal',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: false,
    shareAlike: false,
  },
  {
    spdxId: 'CC-BY-4.0',
    name: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: false,
  },
  {
    spdxId: 'CC-BY-SA-4.0',
    name: 'CC BY-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: true,
  },
  {
    spdxId: 'CC-BY-NC-4.0',
    name: 'CC BY-NC 4.0',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    text: null,
    allowsCommercialUse: false,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: false,
  },
  {
    spdxId: 'CC-BY-ND-4.0',
    name: 'CC BY-ND 4.0',
    url: 'https://creativecommons.org/licenses/by-nd/4.0/',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: false,
    requiresAttribution: true,
    shareAlike: false,
  },
  {
    spdxId: 'MIT',
    name: 'MIT License',
    url: 'https://spdx.org/licenses/MIT.html',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: false,
  },
  {
    spdxId: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://spdx.org/licenses/Apache-2.0.html',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: false,
  },
  {
    spdxId: 'GPL-3.0-only',
    name: 'GNU General Public License v3.0',
    url: 'https://spdx.org/licenses/GPL-3.0-only.html',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: true,
  },
  {
    spdxId: 'BSD-3-Clause',
    name: 'BSD 3-Clause',
    url: 'https://spdx.org/licenses/BSD-3-Clause.html',
    text: null,
    allowsCommercialUse: true,
    allowsRedistribution: true,
    allowsDerivatives: true,
    requiresAttribution: true,
    shareAlike: false,
  },
];

export async function seedLicenses(prisma: PrismaClient): Promise<number> {
  let created = 0;
  for (const license of LICENSES) {
    const result = await prisma.license.upsert({
      where: { spdxId: license.spdxId },
      update: {}, // 不覆盖已有数据
      create: license,
    });
    if (result) created++;
  }
  return created;
}

// 直接运行时执行 seed
async function main() {
  const prisma = new PrismaClient();
  try {
    const count = await seedLicenses(prisma);
    console.log(`Seeded ${count} licenses (upsert)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
