import { get } from '../api-client';

export function checkHealth(): Promise<{ status: string; timestamp: string }> {
  return get('/health');
}
