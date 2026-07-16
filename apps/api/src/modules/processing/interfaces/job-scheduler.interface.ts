import { JobType } from '../../../common/constants/enums';

export const JOB_SCHEDULER = Symbol('JOB_SCHEDULER');

/**
 * 任务处理器回调：接收任务记录，成功返回 void，失败抛出异常
 */
export type JobHandler = (job: {
  id: string;
  resourceId: string;
  jobType: string;
  retryCount: number;
}) => Promise<void>;

/**
 * 任务调度器接口
 *
 * 当前实现：PollingJobScheduler（进程内轮询 processing_jobs 表）
 * 未来实现：BullMQJobScheduler（基于 Redis + BullMQ 队列）
 *
 * 切换时只需在 ProcessingModule 中改 useClass，Processor 代码无需修改。
 */
export interface IJobScheduler {
  /** 将新任务入队（幂等：同资源同类型已有 pending/processing 任务则跳过） */
  enqueue(jobType: JobType, resourceId: string): Promise<void>;

  /** 注册某类任务的处理回调 */
  onJobType(jobType: JobType, handler: JobHandler): void;

  /** 启动调度器（开始轮询） */
  start(): void;

  /** 停止调度器 */
  stop(): void;
}
