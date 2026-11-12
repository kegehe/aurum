import { JobStatus, ProcessingStatus } from '../../common/constants/enums';

/**
 * 按资源的全部任务推导 processingStatus
 *
 * 优先级：任一任务在跑 → processing；否则有待处理 → pending；
 * 否则有成功任务 → completed；全部失败/取消 → failed。
 *
 * 调度器（认领/完成/回收）和 ProcessingService（重试/取消）共用同一份判定，
 * 避免两处逻辑漂移导致资源状态来回跳。
 */
export function resolveResourceProcessingStatus(
  jobs: ReadonlyArray<{ status: string }>,
): ProcessingStatus {
  if (jobs.some((job) => job.status === JobStatus.processing)) return ProcessingStatus.processing;
  if (jobs.some((job) => job.status === JobStatus.pending)) return ProcessingStatus.pending;
  if (jobs.some((job) => job.status === JobStatus.completed)) return ProcessingStatus.completed;
  return ProcessingStatus.failed;
}
