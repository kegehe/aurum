import { DESIGN_BASE_URL, designGet as get, designPost as post } from '../api-client';

export type DesignKind = 'foundation' | 'theme' | 'component' | 'layout' | 'style_pack';

export interface DesignVersion { id: string; versionNumber: number; summary?: string | null; content: string; publishedAt?: string | null; }
export interface DesignDocument { id: string; slug: string; name: string; kind: DesignKind; status: string; currentPublishedVersionId?: string | null; currentPublishedVersion?: DesignVersion | null; versions?: DesignVersion[]; }
export interface Candidate { id: string; label: string; rationale?: string | null; patch: string; structuredDiff?: string | null; impactReport?: string | null; status: string; }
export interface CandidatePreview { viewport: 'desktop' | 'tablet' | 'mobile'; changedPixels: number | null; snapshotUrl: string; diffUrl: string | null; }
export interface DesignTask { id: string; taskType: string; status: string; candidateId?: string | null; errorMessage?: string | null; retryCount: number; createdAt: string; }

export function listDesignDocuments(kind?: string) { return get<DesignDocument[]>('/design/documents', kind ? { kind } : undefined); }
export function getDesignDocument(id: string) { return get<DesignDocument>(`/design/documents/${id}`); }
export function createDesignDocument(input: { name: string; slug: string; kind: DesignKind; content: Record<string, unknown>; summary?: string }) { return post<DesignDocument>('/design/documents', input); }
export function createDraft(documentId: string) { return post<{ id: string }>(`/design/documents/${documentId}/drafts`); }
export function createCandidate(draftId: string, input: { label: string; content: Record<string, unknown>; rationale?: string }) { return post<Candidate>(`/design/drafts/${draftId}/candidates`, input); }
export function queueAiCandidates(draftId: string, input: { intent: string; count?: number }) { return post<{ id: string }>(`/design/drafts/${draftId}/ai-candidates`, input); }
export function renderAndValidateCandidate(candidateId: string) { return post(`/design/candidates/${candidateId}/render-validate`); }
export function listCandidates(draftId: string) { return get<Candidate[]>(`/design/drafts/${draftId}/candidates`); }
export function listCandidatePreviews(candidateId: string) { return get<CandidatePreview[]>(`/design/candidates/${candidateId}/previews`); }
export function getCandidatePreviewUrl(candidateId: string, viewport: CandidatePreview['viewport'], kind: 'snapshot' | 'diff') { return `${DESIGN_BASE_URL}/design/candidates/${candidateId}/previews/${viewport}?kind=${kind}`; }
export function selectCandidate(candidateId: string) { return post<Candidate>(`/design/candidates/${candidateId}/select`); }
export function publishDraft(draftId: string) { return post<DesignVersion>(`/design/drafts/${draftId}/publish`); }
export function restoreDesignVersion(documentId: string, versionId: string) { return post<DesignVersion>(`/design/documents/${documentId}/versions/${versionId}/restore`); }
export function createReferenceDraft(documentId: string, profile: Record<string, unknown>, source = 'style-lab') { return post<{ draftId: string }>(`/design/documents/${documentId}/reference-draft`, { profile, source }); }
export function createChangeSet(draftIds: string[]) { return post<{ id: string }>('/design/change-sets', { draftIds }); }
export function publishChangeSet(changeSetId: string) { return post(`/design/change-sets/${changeSetId}/publish`); }
export function listReadyDrafts() { return get<Array<{ id: string; document: { id: string; name: string; kind: DesignKind }; candidates: Array<{ id: string; label: string }> }>>('/design/drafts/ready'); }
export function listDesignTasks() { return get<DesignTask[]>('/design/tasks'); }
export function cancelDesignTask(taskId: string) { return post<DesignTask>(`/design/tasks/${taskId}/cancel`); }
export function retryDesignTask(taskId: string) { return post<DesignTask>(`/design/tasks/${taskId}/retry`); }
