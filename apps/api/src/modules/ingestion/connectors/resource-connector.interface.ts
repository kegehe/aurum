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

export interface ResourceConnector {
  readonly type: string;
  inspect(url: string, options?: ConnectorInspectOptions): Promise<LinkMetadata>;
}

export interface ConnectorInspectOptions {
  validateUrl?: (url: string) => Promise<void>;
}
