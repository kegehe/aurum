import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SafeUrlService } from './safe-url.service';

describe('SafeUrlService', () => {
  const service = new SafeUrlService();

  it('accepts public HTTP(S) URLs and removes fragments', () => {
    expect(service.normalize('https://example.com/path#section').toString()).toBe('https://example.com/path');
  });

  it('rejects unsafe protocols and embedded credentials', () => {
    expect(() => service.normalize('file:///etc/passwd')).toThrow(BadRequestException);
    expect(() => service.normalize('data:text/html,<h1>hello</h1>')).toThrow(BadRequestException);
    expect(() => service.normalize('ftp://example.com/file')).toThrow(BadRequestException);
    expect(() => service.normalize('javascript:alert(1)')).toThrow(BadRequestException);
    expect(() => service.normalize('https://user:password@example.com')).toThrow(BadRequestException);
  });

  it('blocks loopback, private and link-local addresses', () => {
    const addressCheck = service as unknown as { isPublicAddress(address: string): boolean };
    // Loopback
    expect(addressCheck.isPublicAddress('127.0.0.1')).toBe(false);
    expect(addressCheck.isPublicAddress('::1')).toBe(false);
    expect(addressCheck.isPublicAddress('0.0.0.0')).toBe(false);
    // Private (RFC 1918)
    expect(addressCheck.isPublicAddress('10.0.0.1')).toBe(false);
    expect(addressCheck.isPublicAddress('172.16.0.1')).toBe(false);
    expect(addressCheck.isPublicAddress('192.168.1.1')).toBe(false);
    // Link-local
    expect(addressCheck.isPublicAddress('169.254.169.254')).toBe(false);
    // IPv6-mapped IPv4 loopback/private
    expect(addressCheck.isPublicAddress('::127.0.0.1')).toBe(false);
    expect(addressCheck.isPublicAddress('0:0:0:0:0:ffff:127.0.0.1')).toBe(false);
    expect(addressCheck.isPublicAddress('0:0:0:0:0:ffff:10.0.0.1')).toBe(false);
    // Multicast / reserved
    expect(addressCheck.isPublicAddress('ff02::1')).toBe(false);
    // Public addresses should be accepted
    expect(addressCheck.isPublicAddress('8.8.8.8')).toBe(true);
    expect(addressCheck.isPublicAddress('1.1.1.1')).toBe(true);
  });

  it('cancels a response body that exceeds the size limit', async () => {
    const reader = {
      read: async () => ({ done: false, value: new Uint8Array(4) }),
      cancel: vi.fn(async () => undefined),
      releaseLock: () => undefined,
    };
    const body = { getReader: () => reader };

    await expect(
      (service as unknown as { readLimitedBody: (stream: unknown, maxBytes: number) => Promise<string> })
        .readLimitedBody(body, 2),
    ).rejects.toThrow('Remote HTML exceeds');
    expect(reader.cancel).toHaveBeenCalledOnce();
  });
});
