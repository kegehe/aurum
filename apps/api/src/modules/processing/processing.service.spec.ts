import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JobStatus, ProcessingStatus } from '../../common/constants/enums';
import { ProcessingService } from './processing.service';

function createService() {
  const jobRepo = {
    findMany: vi.fn(),
    findByResourceId: vi.fn(),
    stats: vi.fn(),
    findById: vi.fn(),
    requeueTerminal: vi.fn(),
    cancelActive: vi.fn(),
    deleteTerminal: vi.fn(),
    clearTerminal: vi.fn(),
  };
  const resourceRepo = {
    updateProcessingStatus: vi.fn(),
  };
  const service = new ProcessingService(jobRepo as never, resourceRepo as never);
  return { service, jobRepo, resourceRepo };
}

describe('ProcessingService', () => {
  it('lists jobs with pagination defaults', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findMany.mockResolvedValue({ items: [{ id: 'job-1' }], total: 1 });

    await expect(service.listJobs({})).resolves.toEqual({
      items: [{ id: 'job-1' }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    expect(jobRepo.findMany).toHaveBeenCalledWith({
      status: undefined,
      jobType: undefined,
      resourceId: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  it('returns processing stats from repository', async () => {
    const { service, jobRepo } = createService();
    jobRepo.stats.mockResolvedValue({ failed: 2, pending: 1 });

    await expect(service.getStats()).resolves.toEqual({ failed: 2, pending: 1 });
  });

  it('retries failed/canceled jobs and recomputes the resource status', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      resourceId: 'resource-1',
      jobType: 'detect_metadata',
      status: JobStatus.failed,
    });
    jobRepo.requeueTerminal.mockResolvedValue(true);
    // 重排后的状态重算：同资源只有这条已回到 pending 的任务
    jobRepo.findByResourceId.mockResolvedValue([
      { id: 'job-1', jobType: 'detect_metadata', status: JobStatus.pending },
    ]);

    await expect(service.retryJob('job-1')).resolves.toEqual({
      id: 'job-1',
      status: JobStatus.pending,
    });
    expect(jobRepo.requeueTerminal).toHaveBeenCalledWith('job-1');
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'resource-1',
      ProcessingStatus.pending,
    );
  });

  it('rejects retry when the same resource already has an active job of that type', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'old-job',
      resourceId: 'resource-1',
      jobType: 'detect_metadata',
      status: JobStatus.failed,
    });
    jobRepo.findByResourceId.mockResolvedValue([
      { id: 'old-job', jobType: 'detect_metadata', status: JobStatus.failed },
      { id: 'new-job', jobType: 'detect_metadata', status: JobStatus.pending },
    ]);

    await expect(service.retryJob('old-job')).rejects.toBeInstanceOf(BadRequestException);
    expect(jobRepo.requeueTerminal).not.toHaveBeenCalled();
    expect(resourceRepo.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it('rejects retry when the job was claimed concurrently', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      resourceId: 'resource-1',
      jobType: 'detect_metadata',
      status: JobStatus.failed,
    });
    jobRepo.findByResourceId.mockResolvedValue([
      { id: 'job-1', jobType: 'detect_metadata', status: JobStatus.failed },
    ]);
    jobRepo.requeueTerminal.mockResolvedValue(false);

    await expect(service.retryJob('job-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(resourceRepo.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it('rejects retry for missing jobs', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findById.mockResolvedValue(null);

    await expect(service.retryJob('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects retry for completed, processing, or already queued jobs', async () => {
    const { service, jobRepo, resourceRepo } = createService();

    jobRepo.findById.mockResolvedValueOnce({ id: 'done', status: JobStatus.completed });
    await expect(service.retryJob('done')).rejects.toBeInstanceOf(BadRequestException);

    jobRepo.findById.mockResolvedValueOnce({ id: 'running', status: JobStatus.processing });
    await expect(service.retryJob('running')).rejects.toBeInstanceOf(BadRequestException);

    jobRepo.findById.mockResolvedValueOnce({ id: 'queued', status: JobStatus.pending });
    await expect(service.retryJob('queued')).rejects.toBeInstanceOf(BadRequestException);
    expect(resourceRepo.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it('cancels a stuck processing job and refreshes the resource status', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      resourceId: 'resource-1',
      status: JobStatus.processing,
    });
    jobRepo.cancelActive.mockResolvedValue(true);
    jobRepo.findByResourceId.mockResolvedValue([
      { id: 'job-1', status: JobStatus.canceled },
      { id: 'job-0', status: JobStatus.completed },
    ]);

    await expect(service.cancelJob('job-1')).resolves.toEqual({
      id: 'job-1',
      status: JobStatus.canceled,
    });
    expect(jobRepo.cancelActive).toHaveBeenCalledWith('job-1', 'Canceled by user');
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'resource-1',
      ProcessingStatus.completed,
    );
  });

  it('cancels a pending job too', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      resourceId: 'resource-1',
      status: JobStatus.pending,
    });
    jobRepo.cancelActive.mockResolvedValue(true);
    jobRepo.findByResourceId.mockResolvedValue([{ id: 'job-1', status: JobStatus.canceled }]);

    await expect(service.cancelJob('job-1')).resolves.toEqual({
      id: 'job-1',
      status: JobStatus.canceled,
    });
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'resource-1',
      ProcessingStatus.failed,
    );
  });

  it('rejects cancelling a finished or missing job', async () => {
    const { service, jobRepo } = createService();

    jobRepo.findById.mockResolvedValueOnce({ id: 'done', status: JobStatus.completed });
    await expect(service.cancelJob('done')).rejects.toBeInstanceOf(BadRequestException);

    jobRepo.findById.mockResolvedValueOnce(null);
    await expect(service.cancelJob('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobRepo.cancelActive).not.toHaveBeenCalled();
  });

  it('rejects cancelling when the job stopped being active concurrently', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: JobStatus.processing });
    jobRepo.cancelActive.mockResolvedValue(false);

    await expect(service.cancelJob('job-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(resourceRepo.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it('deletes a terminal job record', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: JobStatus.completed });
    jobRepo.deleteTerminal.mockResolvedValue(true);

    await expect(service.deleteJob('job-1')).resolves.toEqual({ id: 'job-1', deleted: true });
    expect(jobRepo.deleteTerminal).toHaveBeenCalledWith('job-1');
  });

  it('rejects deleting an active job', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findById.mockResolvedValueOnce({ id: 'running', status: JobStatus.processing });
    await expect(service.deleteJob('running')).rejects.toBeInstanceOf(BadRequestException);
    expect(jobRepo.deleteTerminal).not.toHaveBeenCalled();
  });

  it('rejects deleting a missing job', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findById.mockResolvedValue(null);
    await expect(service.deleteJob('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clears all terminal job records and returns the deleted count', async () => {
    const { service, jobRepo } = createService();
    jobRepo.clearTerminal.mockResolvedValue(5);
    await expect(service.clearJobs()).resolves.toEqual({ deleted: 5 });
  });
});
