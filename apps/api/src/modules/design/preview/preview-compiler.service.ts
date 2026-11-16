import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PreviewCompileService as SharedPreviewCompileService,
  type PreviewCompileInput,
  type PreviewCompileResult,
} from '@aurum/design-preview';
import { PreviewRendererClient } from './preview-renderer.client';

export * from '@aurum/design-preview';

@Injectable()
export class PreviewCompileService extends SharedPreviewCompileService {
  private readonly renderer?: PreviewRendererClient;

  constructor(@Optional() config?: ConfigService) {
    super();
    if (config) this.renderer = new PreviewRendererClient(config);
  }

  override async compile(input: PreviewCompileInput): Promise<PreviewCompileResult> {
    if (this.renderer?.enabled) {
      return this.renderer.compile(input.manifest, input.files);
    }
    return super.compile(input);
  }
}

