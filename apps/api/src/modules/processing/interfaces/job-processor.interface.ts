import { JobType } from '../../../common/constants/enums';

/**
 * 任务处理器接口
 *
 * 每种 JobType 对应一个 Processor 实现。
 * 处理器从 storage 读取文件，处理后写回派生文件或更新资源元数据。
 */
export interface IJobProcessor {
  /** 此处理器处理的任务类型 */
  readonly jobType: JobType;

  /**
   * 处理单个任务
   * @param resourceId 资源 ID
   * @param jobId 任务 ID（用于日志/状态更新）
   * @throws 处理失败时抛出异常，由调度器处理重试
   */
  process(resourceId: string, jobId: string): Promise<void>;
}
