// DTO 用到 @Type() 反射元数据：Nest 运行时自动加载，单元测试里要显式引入。
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SearchResourceDto } from './search-resource.dto';

/**
 * 前端把嵌套筛选条件序列化成 sizeRange[min]=... / createdAtRange[start]=...，
 * express 的 qs 解析器会还原成嵌套对象后交给 DTO 校验。
 * 这里覆盖"还原之后"的类型转换：sizeRange 必须是 number（search.service 里会走 BigInt()，
 * 字符串日期反而没问题，但字符串大小会在 BigInt('524288000') 之外的值上炸掉）。
 */
describe('SearchResourceDto', () => {
  it('字符串形式的大小范围会被转换成 number', async () => {
    const dto = plainToInstance(
      SearchResourceDto,
      { sizeRange: { min: '524288000', max: '1073741824' } },
      { enableImplicitConversion: true },
    );

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.sizeRange).toEqual({ min: 524288000, max: 1073741824 });
  });

  it('接受 ISO 时间范围与作者条件', async () => {
    const dto = plainToInstance(
      SearchResourceDto,
      {
        author: '张三',
        createdAtRange: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-27T23:59:59.999Z' },
      },
      { enableImplicitConversion: true },
    );

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('拒绝非法日期与负数大小', async () => {
    const errors = await validate(
      plainToInstance(
        SearchResourceDto,
        { createdAtRange: { start: 'not-a-date' }, sizeRange: { min: '-1' } },
        { enableImplicitConversion: true },
      ),
    );

    const paths = errors.map((error) => error.property);
    expect(paths).toContain('createdAtRange');
    expect(paths).toContain('sizeRange');
  });
});
