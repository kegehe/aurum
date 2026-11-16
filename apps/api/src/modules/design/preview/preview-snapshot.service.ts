import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PreviewSnapshotService as SharedPreviewSnapshotService,
  type PreviewState,
  type PreviewViewport,
} from '@aurum/design-preview';
import { PreviewRendererClient } from './preview-renderer.client';

export * from '@aurum/design-preview';

@Injectable()
export class PreviewSnapshotService extends SharedPreviewSnapshotService {
  private readonly renderer?: PreviewRendererClient;

  constructor(@Optional() config?: ConfigService) {
    super();
    if (config) this.renderer = new PreviewRendererClient(config);
  }

  override async capture(
    html: string,
    viewport: PreviewViewport = 'desktop',
    state: PreviewState = 'default',
  ): Promise<Buffer> {
    if (this.renderer?.enabled) {
      return this.renderer.screenshot(html, viewport, state);
    }
    return super.capture(html, viewport, state);
  }
}

