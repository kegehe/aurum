import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LicenseRepository } from './repositories/license.repository';
import { CreateLicenseDto } from './dto/create-license.dto';
import { UpdateLicenseDto } from './dto/update-license.dto';
import { QueryLicensesDto } from './dto/query-licenses.dto';

/**
 * 许可证应用服务
 * 职责：许可证 CRUD、spdxId 唯一性、删除保护
 */
@Injectable()
export class LicenseService {
  constructor(private readonly licenseRepo: LicenseRepository) {}

  /** 分页查询许可证列表 */
  async listLicenses(query: QueryLicensesDto) {
    const result = await this.licenseRepo.findMany({
      requiresAttribution: query.requiresAttribution,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
    return { ...result, totalPages: Math.ceil(result.total / result.pageSize) };
  }

  /** 获取单个许可证 */
  async getLicense(id: string) {
    const license = await this.licenseRepo.findById(id);
    if (!license) throw new NotFoundException(`License ${id} not found`);
    return license;
  }

  /** 创建许可证 */
  async createLicense(dto: CreateLicenseDto) {
    // 校验 spdxId 唯一（如果提供）
    if (dto.spdxId) {
      const existing = await this.licenseRepo.findBySpdxId(dto.spdxId);
      if (existing) {
        throw new ConflictException(`License with SPDX ID "${dto.spdxId}" already exists`);
      }
    }

    try {
      return await this.licenseRepo.create({
        spdxId: dto.spdxId,
        name: dto.name,
        url: dto.url,
        text: dto.text,
        allowsCommercialUse: dto.allowsCommercialUse,
        allowsRedistribution: dto.allowsRedistribution,
        allowsDerivatives: dto.allowsDerivatives,
        requiresAttribution: dto.requiresAttribution ?? false,
        shareAlike: dto.shareAlike ?? false,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`License with SPDX ID "${dto.spdxId}" already exists`);
      }
      throw error;
    }
  }

  /** 更新许可证 */
  async updateLicense(id: string, dto: UpdateLicenseDto) {
    const existing = await this.licenseRepo.findById(id);
    if (!existing) throw new NotFoundException(`License ${id} not found`);

    // 如果更新 spdxId，校验唯一性
    if (dto.spdxId && dto.spdxId !== existing.spdxId) {
      const conflict = await this.licenseRepo.findBySpdxId(dto.spdxId);
      if (conflict) {
        throw new ConflictException(`License with SPDX ID "${dto.spdxId}" already exists`);
      }
    }

    try {
      return await this.licenseRepo.update(id, {
        spdxId: dto.spdxId === undefined ? undefined : (dto.spdxId as string | null),
        name: dto.name,
        url: dto.url === undefined ? undefined : (dto.url as string | null),
        text: dto.text === undefined ? undefined : (dto.text as string | null),
        allowsCommercialUse: dto.allowsCommercialUse,
        allowsRedistribution: dto.allowsRedistribution,
        allowsDerivatives: dto.allowsDerivatives,
        requiresAttribution: dto.requiresAttribution,
        shareAlike: dto.shareAlike,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`License with SPDX ID "${dto.spdxId}" already exists`);
      }
      throw error;
    }
  }

  /** 删除许可证（仅允许删除无关联资源和来源的许可证） */
  async deleteLicense(id: string) {
    const result = await this.licenseRepo.delete(id);
    if (!result.deleted) {
      if (result.reason === 'not_found') {
        throw new NotFoundException(`License ${id} not found`);
      }
      if (result.reason === 'has_resources') {
        throw new BadRequestException(
          'Cannot delete a license that is assigned to resources',
        );
      }
      if (result.reason === 'has_sources') {
        throw new BadRequestException(
          'Cannot delete a license that is set as default for sources',
        );
      }
    }
    return { id, deleted: true };
  }
}
