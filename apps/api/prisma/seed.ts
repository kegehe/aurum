import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 默认分类（与方案文档 6.5 节一致）
 */
const DEFAULT_CATEGORIES = [
  { name: '图片', sortOrder: 1 },
  { name: '视频', sortOrder: 2 },
  { name: '音频', sortOrder: 3 },
  { name: '文档', sortOrder: 4 },
  { name: '游戏素材', sortOrder: 5 },
  { name: '设计素材', sortOrder: 6 },
  { name: '代码/配置', sortOrder: 7 },
  { name: '压缩包', sortOrder: 8 },
  { name: '其他', sortOrder: 9 },
];

/**
 * 测试标签（与方案文档 6.4 节示例一致）
 */
const DEFAULT_TAGS = [
  { name: 'UI', color: '#3B82F6' },
  { name: '角色', color: '#10B981' },
  { name: '场景', color: '#F59E0B' },
  { name: '音效', color: '#8B5CF6' },
  { name: 'BGM', color: '#EC4899' },
  { name: '像素风', color: '#6366F1' },
];

async function seedCategories() {
  let count = 0;
  for (const cat of DEFAULT_CATEGORIES) {
    const existing = await prisma.category.findFirst({
      where: { name: cat.name, parentId: null },
    });
    if (existing) {
      await prisma.category.update({
        where: { id: existing.id },
        data: { sortOrder: cat.sortOrder },
      });
    } else {
      await prisma.category.create({
        data: { name: cat.name, sortOrder: cat.sortOrder },
      });
      count++;
    }
  }
  console.log(`分类处理完成（新增 ${count}，共 ${DEFAULT_CATEGORIES.length}）`);
}

async function seedTags() {
  let count = 0;
  for (const tag of DEFAULT_TAGS) {
    const existing = await prisma.tag.findUnique({ where: { name: tag.name } });
    if (existing) {
      await prisma.tag.update({
        where: { id: existing.id },
        data: { color: tag.color },
      });
    } else {
      await prisma.tag.create({ data: tag });
      count++;
    }
  }
  console.log(`标签处理完成（新增 ${count}，共 ${DEFAULT_TAGS.length}）`);
}

async function main() {
  console.log('开始填充种子数据...');
  await seedCategories();
  await seedTags();
  console.log('种子数据填充完成');
}

main()
  .catch((e) => {
    console.error('种子数据填充失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
