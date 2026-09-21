import { del, get, post, type PaginatedResponse } from '../api-client';
import type { ProcessingJobItem, ProcessingJobStats } from '../types';
import type { JobStatus, JobType } from '@aurum/shared-types';

/** 处理任务列表 */
export function listProcessingJobs(params?: {
  page?: number;
  pageSize?: number;
  status?: JobStatus;
  jobType?: JobType;
  resourceId?: string;
}): Promise<PaginatedResponse<ProcessingJobItem>> {
  return get('/processing/jobs', params as Record<string, unknown>);
}

/** 处理任务统计 */
export function getProcessingStats(): Promise<ProcessingJobStats> {
  return get('/processing/stats');
}

/** 重试失败任务 */
export function retryJob(jobId: string): Promise<{ id: string; status: string }> {
  return post(`/processing/jobs/${jobId}/retry`);
}

/** 删除指定已结束（terminal）的处理任务记录 */
export function deleteProcessingJob(jobId: string): Promise<{ id: string; deleted: boolean }> {
  return del(`/processing/jobs/${jobId}`);
}

/** 清空所有已结束（terminal）的处理任务记录 */
export function clearProcessingJobs(): Promise<{ deleted: number }> {
  return del('/processing/jobs');
}
