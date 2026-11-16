import { JobStatus, ProcessingStatus } from '../../common/constants/enums';

/** 判定所需的最小任务字段（Prisma ProcessingJob 结构兼容） */
export interface ResourceJobStatus {
  status: string;
  jobType?: string | null;
  createdAt?: Date | string | number | null;
  id?: string | null;
}

/**
 * 按资源的全部任务推导 processingStatus
 *
 * 优先级：任一任务在跑 → processing；否则有待处理 → pending。
 * 终态任务按「每种任务类型的最新一条」判定：
 * - 存在失败的最新任务 → failed
 * - 否则存在成功的最新任务 → completed
 * - 只剩取消（或没有任何任务）→ failed
 *
 * 两个关键约束：
 * 1. 重新处理会给同一类型追加新任务，旧的失败记录不能继续压着资源，
 *    所以同类型只认最新一条（按 createdAt，必要时用 id 兜底保证确定性）。
 * 2. 封面等下游任务永久失败，不能被更早成功的元数据任务掩盖成 completed，
 *    否则用户看不到「处理失败」，也不会去重新处理。
 *
 * 调度器（认领/完成/回收）和 ProcessingService（重试/取消）共用同一份判定，
 * 避免两处逻辑漂移导致资源状态来回跳。
 */
export function resolveResourceProcessingStatus(
  jobs: ReadonlyArray<ResourceJobStatus>,
): ProcessingStatus {
  if (jobs.some((job) => job.status === JobStatus.processing)) return ProcessingStatus.processing;
  if (jobs.some((job) => job.status === JobStatus.pending)) return ProcessingStatus.pending;

  const latestByType = new Map<string, ResourceJobStatus>();
  jobs.forEach((job, index) => {
    // 没有 jobType 的调用方（旧测试替身）按独立任务处理，避免把互不相关的任务归成一组
    const key = job.jobType ?? `__untyped_${index}`;
    const previous = latestByType.get(key);
    if (!previous || isNewer(job, previous)) {
      latestByType.set(key, job);
    }
  });
  const latest = [...latestByType.values()];

  if (latest.some((job) => job.status === JobStatus.failed)) return ProcessingStatus.failed;
  if (latest.some((job) => job.status === JobStatus.completed)) return ProcessingStatus.completed;
  return ProcessingStatus.failed;
}

/** 同类型任务的先后：createdAt 优先，缺失或同毫秒时用 id 兜底，保证结果稳定 */
function isNewer(candidate: ResourceJobStatus, current: ResourceJobStatus): boolean {
  const candidateTime = toTime(candidate.createdAt);
  const currentTime = toTime(current.createdAt);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return (candidate.id ?? '') > (current.id ?? '');
}

function toTime(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
