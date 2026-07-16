import { get, post } from '../api-client';
import type { CreateLinkImportData, IngestionJobItem } from '../types';

export function createLinkImport(data: CreateLinkImportData): Promise<IngestionJobItem> {
  return post('/imports/link', data);
}

export function getIngestionJob(id: string): Promise<IngestionJobItem> {
  return get(`/ingestion/jobs/${id}`);
}

export function retryIngestionJob(id: string): Promise<IngestionJobItem> {
  return post(`/ingestion/jobs/${id}/retry`);
}
