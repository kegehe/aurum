import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JobStatus, JobType } from '../../../common/constants/enums';

/**
 * 处理任务列表查询参数
 */
export class QueryProcessingJobsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  @IsEnum(JobType)
  jobType?: JobType;

  @IsOptional()
  @IsString()
  resourceId?: string;
}
