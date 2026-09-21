import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JobStatus, ProcessingStatus } from '../../common/constants/enums';
import { ProcessingService } from './processing.service';

function createService() {
  const jobRepo = {
    findMany: vi.fn(),
    stats: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn(),
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

  it('retries non-completed non-processing jobs and marks the resource processing', async () => {
    const { service, jobRepo, resourceRepo } = createService();
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      resourceId: 'resource-1',
      status: JobStatus.failed,
    });

    await expect(service.retryJob('job-1')).resolves.toEqual({
      id: 'job-1',
      status: JobStatus.pending,
    });
    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', JobStatus.pending, null);
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'resource-1',
      ProcessingStatus.processing,
    );
  });

  it('rejects retry for missing jobs', async () => {
    const { service, jobRepo } = createService();
    jobRepo.findById.mockResolvedValue(null);

    await expect(service.retryJob('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects retry for completed or processing jobs', async () => {
    const { service, jobRepo, resourceRepo } = createService();

    jobRepo.findById.mockResolvedValueOnce({ id: 'done', status: JobStatus.completed });
    await expect(service.retryJob('done')).rejects.toBeInstanceOf(BadRequestException);

    jobRepo.findById.mockResolvedValueOnce({ id: 'running', status: JobStatus.processing });
    await expect(service.retryJob('running')).rejects.toBeInstanceOf(BadRequestException);
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
