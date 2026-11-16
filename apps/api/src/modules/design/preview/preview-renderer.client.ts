import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PreviewCompileResult,
  PreviewFile,
  PreviewManifest,
  PreviewState,
  PreviewViewport,
} from '@aurum/design-preview';

@Injectable()
export class PreviewRendererClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string | null {
    return this.config.get<string>('DESIGN_RENDERER_URL')?.replace(/\/$/, '') || null;
  }

  private get key(): string {
    return this.config.get<string>('DESIGN_RENDERER_KEY') || '';
  }

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  async compile(manifest: PreviewManifest, files: PreviewFile[]): Promise<PreviewCompileResult> {
    const response = await this.request('/internal/compile', { manifest, files }, 25_000);
    return (await response.json()) as PreviewCompileResult;
  }

  async screenshot(
    html: string,
    viewport: PreviewViewport,
    state: PreviewState,
  ): Promise<Buffer> {
    const response = await this.request(
      '/internal/screenshot',
      { html, viewport, state },
      30_000,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  private async request(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new ServiceUnavailableException('Design renderer 未配置');
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { 'x-design-renderer-key': this.key } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      throw new ServiceUnavailableException(
        `Design renderer 不可用：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ServiceUnavailableException(
        `Design renderer 返回 ${response.status}：${text.slice(0, 500)}`,
      );
    }
    return response;
  }
}
