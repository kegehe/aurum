import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PreviewCompileService } from './preview-compiler.service';
import { PreviewSnapshotService } from './preview-snapshot.service';

describe('PreviewSnapshotService', () => {
  it('captures a deterministic desktop snapshot from the compiled sample', async () => {
    const compiled = await new PreviewCompileService().compileSample();
    const png = await new PreviewSnapshotService().capture(compiled.html, 'desktop', 'default');
    const metadata = await sharp(png).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(960);
    // 真实启动一遍浏览器再编译 Tailwind，整包并发跑时 30s 会踩线（单跑约 14s）
  }, 120_000);

  it('captures static html that has no data-part markers', async () => {
    const png = await new PreviewSnapshotService().capture(
      '<!doctype html><html><body><div id="root"><p>hello</p></div></body></html>',
      'desktop',
      'default',
    );
    const metadata = await sharp(png).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(960);
  }, 60_000);
});
