import { describe, expect, it } from 'vitest';
import { envValidationSchema } from './env.validation';

const base = { DATABASE_URL: 'file:./test.db' };

describe('env validation: worker timeouts', () => {
  it('accepts the defaults', () => {
    const { error } = envValidationSchema.validate(base);
    expect(error).toBeUndefined();
  });

  it('rejects a max execution limit that does not exceed the stale timeout', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      WORKER_STALE_JOB_TIMEOUT_MS: 300_000,
      WORKER_MAX_EXECUTION_MS: 120_000,
    });
    expect(error?.message).toContain('WORKER_MAX_EXECUTION_MS');
  });

  it('rejects a max execution limit below the default stale timeout', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      WORKER_MAX_EXECUTION_MS: 100_000,
    });
    expect(error?.message).toContain('WORKER_MAX_EXECUTION_MS');
  });

  it('accepts a max execution limit above the stale timeout', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      WORKER_STALE_JOB_TIMEOUT_MS: 60_000,
      WORKER_MAX_EXECUTION_MS: 600_000,
    });
    expect(error).toBeUndefined();
  });

  it('rejects a stale timeout raised above the default max execution limit', () => {
    const { error } = envValidationSchema.validate({
      ...base,
      WORKER_STALE_JOB_TIMEOUT_MS: 3_600_000,
    });
    expect(error?.message).toContain('WORKER_MAX_EXECUTION_MS');
  });

  it('handles string values the way process.env provides them', () => {
    const ok = envValidationSchema.validate({
      ...base,
      WORKER_STALE_JOB_TIMEOUT_MS: '60000',
      WORKER_MAX_EXECUTION_MS: '120000',
    });
    expect(ok.error).toBeUndefined();

    const bad = envValidationSchema.validate({
      ...base,
      WORKER_STALE_JOB_TIMEOUT_MS: '300000',
      WORKER_MAX_EXECUTION_MS: '120000',
    });
    expect(bad.error?.message).toContain('WORKER_MAX_EXECUTION_MS');
  });
});
