import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * 分类引用校验工具
 *
 * 上传/编辑资源时，如果所选分类在提交前已被删除，Prisma 会抛出数据库外键错误，
 * 被全局异常过滤器转成 500。这里提供统一的校验与错误翻译，让这类情况返回可读的 400。
 *
 * Prisma 报错分两类（已用 SQLite 实测验证）：
 * - P2025（connect 的关联记录不存在）：消息会标明缺失的模型名，例如
 *   "No 'Category' record(s) ... was found for a nested connect"。注意：当 data 含
 *   分类 connect 时，即使实际缺失的是外层资源（被并发删除），消息也会优先报告嵌套
 *   connect 的 'Category'。因此"消息提到 Category"并不能单独区分两种缺失，调用方在
 *   需要精确语义时（如 ResourceService.update 的竞态兜底）须额外复查分类是否存在。
 * - P2003（外键约束失败，updateMany 直接写 categoryId）：SQLite 的消息是通用的
 *   "Foreign key constraint violated: `foreign key`"，不含具体字段名。因此
 *   P2003 由调用方按操作上下文判定——这些操作唯一可能写到的外键就是 categoryId。
 */

/** 可读的"分类不存在"参数错误（400） */
export function categoryDoesNotExistError(categoryId: string | null): BadRequestException {
  return new BadRequestException(
    `Category ${categoryId} does not exist (it may have been deleted)`,
  );
}

/**
 * P2025：connect 的关联记录不存在，且消息提到 Category。
 * 注意：仅表示"消息与分类有关"，不代表缺失的一定是分类（见文件顶部说明）。
 */
export function isCategoryConnectError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2025') return false;
  return /category/i.test(error.message);
}

/** P2003：直接写外键时外键约束失败（updateMany 写 categoryId）。消息通用，仅按错误码判定 */
export function isCategoryWriteError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === 'P2003';
}

/**
 * 校验分类存在；已被删除的分类直接返回 400（而非数据库外键错误 → 500）
 * @param findCategory 按 id 查询分类（返回 null 表示不存在）
 */
export async function assertCategoryExists(
  findCategory: (categoryId: string) => Promise<{ id: string } | null>,
  categoryId: string,
): Promise<void> {
  const category = await findCategory(categoryId);
  if (!category) {
    throw categoryDoesNotExistError(categoryId);
  }
}
