export interface LinkMetadata {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  title: string;
  description: string | null;
  publisher: string | null;
  faviconUrl: string | null;
  previewUrl: string | null;
  httpStatus: number;
  contentType: string | null;
  contentLength: bigint | null;
  etag: string | null;
  lastModified: Date | null;
  rawMetadata: Record<string, string | boolean>;
}

/** A single remote resource extracted from an external source page */
export interface RemoteResource {
  /** External ID from the source (e.g. Civitai image ID) */
  externalId: string;
  /** The direct URL to the resource content */
  url: string;
  /** Canonical URL on the source platform */
  canonicalUrl?: string;
  /** Resource type (image, video, etc.) */
  resourceType: string;
  /** MIME type if known */
  mimeType?: string;
  /** Title or name */
  title: string;
  /** Description */
  description?: string | null;
  /** Author/creator name */
  authorName?: string | null;
  /** Author profile URL */
  authorUrl?: string | null;
  /** Publisher/platform name */
  publisher?: string | null;
  /** Preview/thumbnail URL */
  previewUrl?: string | null;
  /** Width in pixels */
  width?: number | null;
  /** Height in pixels */
  height?: number | null;
  /** When the resource was created on the external platform */
  externalCreatedAt?: Date | null;
  /** Raw metadata from the source API response */
  rawMetadata: Record<string, unknown>;
  /** Additional locators (e.g. page URL, API URL) */
  additionalLocators?: Array<{
    locatorType: string;
    url: string;
  }>;
}

/** A page of results from a sync operation */
export interface SyncPage {
  /** Resources extracted from this page */
  items: RemoteResource[];
  /** Cursor/token for the next page, null if no more pages */
  nextCursor: string | null;
  /** Total items available (if the API reports it) */
  totalItems?: number | null;
}

/** Options for a sync operation */
export interface SyncOptions {
  /** Cursor to resume from (from Source.config) */
  cursor?: string | null;
  /** Maximum number of items per page request */
  limit?: number;
  /** Additional filter parameters from Source.config */
  filters?: Record<string, unknown>;
}

export interface ResourceConnector {
  readonly type: string;
  inspect(url: string, options?: ConnectorInspectOptions): Promise<LinkMetadata>;
  /** Sync a page of resources from the external source */
  sync(options: SyncOptions): Promise<SyncPage>;
}

export interface ConnectorInspectOptions {
  validateUrl?: (url: string) => Promise<void>;
}
