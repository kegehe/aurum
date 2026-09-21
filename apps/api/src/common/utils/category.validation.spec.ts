import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCategoryExists,
  categoryDoesNotExistError,
  isCategoryConnectError,
  isCategoryWriteError,
} from './category.validation';

function prismaError(message: string, code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

describe('isCategoryConnectError (P2025, connect 缺失)', () => {
  it('detects P2025 connect errors for a missing category', () => {
    expect(
      isCategoryConnectError(
        prismaError(
          "An operation failed because it depends on one or more records that were required but not found.\nCause: No 'Category' record(s) was found for a nested connect on 'Resource#r1'.",
          'P2025',
        ),
      ),
    ).toBe(true);
  });

  it('rejects P2025 errors that do not reference the category', () => {
    expect(
      isCategoryConnectError(
        prismaError(
          'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
          'P2025',
        ),
      ),
    ).toBe(false);
  });

  it('rejects P2003 and non-Prisma errors', () => {
    expect(
      isCategoryConnectError(
        prismaError('Foreign key constraint violated: `foreign key`', 'P2003'),
      ),
    ).toBe(false);
    expect(isCategoryConnectError(new Error('boom'))).toBe(false);
  });
});

describe('isCategoryWriteError (P2003, updateMany 直接写外键)', () => {
  it('detects P2003 regardless of the generic SQLite message', () => {
    expect(
      isCategoryWriteError(prismaError('Foreign key constraint violated: `foreign key`', 'P2003')),
    ).toBe(true);
  });

  it('rejects P2025 and non-Prisma errors', () => {
    expect(isCategoryWriteError(prismaError('Record to update not found.', 'P2025'))).toBe(false);
    expect(isCategoryWriteError('string error')).toBe(false);
  });
});

describe('assertCategoryExists', () => {
  it('throws a readable BadRequestException when the category is missing', async () => {
    const findCategory = vi.fn().mockResolvedValue(null);

    await expect(assertCategoryExists(findCategory, 'cat-missing')).rejects.toThrow(
      BadRequestException,
    );
    expect(findCategory).toHaveBeenCalledWith('cat-missing');
  });

  it('resolves when the category exists', async () => {
    const findCategory = vi.fn().mockResolvedValue({ id: 'cat-1' });

    await expect(assertCategoryExists(findCategory, 'cat-1')).resolves.toBeUndefined();
  });
});

describe('categoryDoesNotExistError', () => {
  it('builds a 400 with a readable message', () => {
    const error = categoryDoesNotExistError('cat-1');
    expect(error.getStatus()).toBe(400);
    expect(error.message).toBe('Category cat-1 does not exist (it may have been deleted)');
  });
});
