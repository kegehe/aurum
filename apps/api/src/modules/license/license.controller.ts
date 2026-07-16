import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { LicenseService } from './license.service';
import { CreateLicenseDto } from './dto/create-license.dto';
import { UpdateLicenseDto } from './dto/update-license.dto';
import { QueryLicensesDto } from './dto/query-licenses.dto';

@Controller('licenses')
export class LicenseController {
  constructor(private readonly licenseService: LicenseService) {}

  /** 查询许可证列表 */
  @Get()
  list(@Query() query: QueryLicensesDto) {
    return this.licenseService.listLicenses(query);
  }

  /** 获取单个许可证 */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.licenseService.getLicense(id);
  }

  /** 创建许可证 */
  @Post()
  create(@Body() dto: CreateLicenseDto) {
    return this.licenseService.createLicense(dto);
  }

  /** 更新许可证 */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLicenseDto) {
    return this.licenseService.updateLicense(id, dto);
  }

  /** 删除许可证（仅允许删除无关联资源的许可证） */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.licenseService.deleteLicense(id);
  }
}
