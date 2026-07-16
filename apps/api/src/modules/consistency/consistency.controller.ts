import { Controller, Get } from '@nestjs/common';
import { ConsistencyService } from './consistency.service';

@Controller('consistency')
export class ConsistencyController {
  constructor(private readonly consistencyService: ConsistencyService) {}

  /** 输出数据库与文件存储的一致性检查报告，不执行清理 */
  @Get('check')
  check() {
    return this.consistencyService.check();
  }
}
