import { describe, expect, it } from 'vitest';
import { PreviewCompileService } from './preview-compiler.service';
import { SAMPLE_PREVIEW_FILES, SAMPLE_PREVIEW_MANIFEST } from './preview-sample';

describe('PreviewCompileService', () => {
  // 这一步要真的跑一遍 Tailwind + esbuild，默认 5s 超时在负载高的机器上会假失败
  it('compiles the sample button into a sandboxed preview', { timeout: 60_000 }, async () => {
    const service = new PreviewCompileService();
    const result = await service.compileSample();

    expect(result.classes).toContain('bg-sky-500');
    expect(result.css).toContain('.bg-sky-500');
    expect(result.css).toContain('.aurum-preview');
    expect(result.js).toContain('data-part');
    expect(result.jsBytes).toBeGreaterThan(10_000);
    expect(result.html).toContain('Content-Security-Policy');
    expect(result.html).toContain("script-src 'unsafe-inline'");
    expect(result.html).toContain('<div id="root"></div>');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.html).toContain("connect-src 'none'");
  });

  it('rejects path traversal and remote code', async () => {
    const service = new PreviewCompileService();
    await expect(
      service.compile({
        manifest: SAMPLE_PREVIEW_MANIFEST,
        files: [...SAMPLE_PREVIEW_FILES, { path: '../escape.tsx', content: 'export default 1' }],
      }),
    ).rejects.toThrow(/不安全的文件路径/);

    await expect(
      service.compile({
        manifest: SAMPLE_PREVIEW_MANIFEST,
        files: SAMPLE_PREVIEW_FILES.map((file) =>
          file.path === 'files/glass-button.tsx'
            ? { ...file, content: file.content + '\nfetch("https://example.com")' }
            : file,
        ),
      }),
    ).rejects.toThrow(/不允许的网络或动态执行代码/);

    await expect(
      service.compile({
        manifest: SAMPLE_PREVIEW_MANIFEST,
        files: SAMPLE_PREVIEW_FILES.map((file) =>
          file.path === 'files/glass-button.tsx'
            ? { ...file, content: `import fs from 'fs';\n${file.content}` }
            : file,
        ),
      }),
    ).rejects.toThrow(/不允许的导入/);

    await expect(
      service.compile({
        manifest: SAMPLE_PREVIEW_MANIFEST,
        files: SAMPLE_PREVIEW_FILES.map((file) =>
          file.path === 'preview/preview.tsx'
            ? { ...file, content: `import '../../escape';\n${file.content}` }
            : file,
        ),
      }),
    ).rejects.toThrow(/导入路径越出资产包/);
  });
});
