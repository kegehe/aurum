import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SAMPLE_PREVIEW_FILES, SAMPLE_PREVIEW_MANIFEST } from './preview-sample';
import { collectTailwindClasses } from './tailwind-classes';

export interface PreviewFile {
  path: string;
  content: string;
  target?: string;
  type?: string;
  language?: string;
}

export interface PreviewManifest {
  schemaVersion: 'aurum.asset.v1';
  slug: string;
  name: string;
  kind: 'component' | 'layout' | 'animation';
  subtype?: string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  source?: string;
  preview: { entry: string };
  files: Array<{
    path: string;
    target?: string;
    type?: string;
    language?: string;
  }>;
  states?: string[];
  parts?: Array<{ id: string; name: string; selector?: string }>;
  tokens?: string[];
  tailwindClasses?: string[];
  dependencies?: string[];
  registryDependencies?: string[];
  assetDependencies?: Array<{ slug: string; version: number }>;
  ai?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  motion?: Record<string, unknown>;
}

export interface PreviewCompileInput {
  manifest: PreviewManifest;
  files: PreviewFile[];
}

export interface PreviewCompileResult {
  html: string;
  css: string;
  js: string;
  classes: string[];
  contentHash: string;
  cssBytes: number;
  jsBytes: number;
}

const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_FILES = 40;
const FORBIDDEN_SOURCE =
  /\b(?:fetch|XMLHttpRequest|WebSocket|eval|new\s+Function|dangerouslySetInnerHTML|document\.write|new\s+Worker)\b|https?:\/\/|data:text\/html|javascript\s*:|vbscript\s*:/i;
const ALLOWED_IMPORTS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'clsx',
  'class-variance-authority',
  'tailwind-merge',
  'lucide-react',
]);
const STATIC_IMPORT = /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_IMPORT = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g;

/**
 * Phase 0 预览编译器。
 *
 * 只做三件事：把资产包写到临时目录、用 esbuild 打成浏览器 bundle、用
 * Tailwind 4 编译类名。它不执行资产 React 代码——真正的渲染发生在 iframe 里。
 */
@Injectable()
export class PreviewCompileService {
  async compile(input: PreviewCompileInput): Promise<PreviewCompileResult> {
    this.validate(input);
    const appRoot = path.resolve(__dirname, '..');
    const dir = await mkdtemp(path.join(tmpdir(), 'aurum-preview-'));
    try {
      await this.writePackage(dir, input);
      const classes = collectTailwindClasses(input.files, input.manifest.tailwindClasses ?? []);
      const css = await this.withTimeout(
        this.compileCss(appRoot, classes, input.files),
        20_000,
        'Tailwind 编译超时',
      );
      const js = await this.withTimeout(this.bundle(appRoot, dir), 20_000, '浏览器打包超时');
      const html = this.shell(css, js);
      return {
        html,
        css,
        js,
        classes,
        contentHash: createHash('sha256').update(html).digest('hex'),
        cssBytes: Buffer.byteLength(css),
        jsBytes: Buffer.byteLength(js),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`预览编译失败：${message.slice(0, 500)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async compileSample(): Promise<
    PreviewCompileResult & { manifest: PreviewManifest; files: PreviewFile[] }
  > {
    const result = await this.compile({
      manifest: SAMPLE_PREVIEW_MANIFEST,
      files: SAMPLE_PREVIEW_FILES,
    });
    return {
      ...result,
      manifest: SAMPLE_PREVIEW_MANIFEST,
      files: SAMPLE_PREVIEW_FILES,
    };
  }

  private validate(input: PreviewCompileInput): void {
    if (!input?.manifest || !Array.isArray(input.files)) {
      throw new BadRequestException('预览资产必须包含 manifest 和 files');
    }
    if (!Array.isArray(input.manifest.files) || typeof input.manifest.preview?.entry !== 'string') {
      throw new BadRequestException('manifest 必须包含 files 和 preview.entry');
    }
    if (input.files.length === 0 || input.files.length > MAX_FILES) {
      throw new BadRequestException(`资产文件数必须在 1–${MAX_FILES} 之间`);
    }
    const paths = new Set<string>();
    let total = 0;
    for (const file of input.files) {
      this.assertSafePath(file.path);
      if (paths.has(file.path)) throw new BadRequestException(`重复文件：${file.path}`);
      paths.add(file.path);
      const bytes = Buffer.byteLength(file.content);
      if (bytes > MAX_FILE_BYTES) throw new BadRequestException(`文件过大：${file.path}`);
      total += bytes;
      if (FORBIDDEN_SOURCE.test(file.content)) {
        throw new BadRequestException(`文件包含不允许的网络或动态执行代码：${file.path}`);
      }
      if (/\.(tsx|ts|jsx|js|mjs|mts|cjs|cts)$/.test(file.path)) this.validateImports(file);
      if (file.path.endsWith('.css') && /@import/i.test(file.content)) {
        throw new BadRequestException(`CSS 不允许 @import：${file.path}`);
      }
    }
    if (total > MAX_TOTAL_BYTES) throw new BadRequestException('资产包超过 1MB 限制');
    if (!paths.has(input.manifest.preview.entry)) {
      throw new BadRequestException('manifest.preview.entry 不在 files 中');
    }
    for (const file of input.manifest.files) {
      if (!paths.has(file.path)) {
        throw new BadRequestException(`manifest.files 引用了不存在的文件：${file.path}`);
      }
    }
  }

  private validateImports(file: PreviewFile): void {
    const specifiers = new Set<string>();
    for (const regex of [STATIC_IMPORT, REQUIRE_IMPORT, EXPORT_FROM]) {
      regex.lastIndex = 0;
      for (const match of file.content.matchAll(regex)) specifiers.add(match[1]);
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(file.path), specifier),
        );
        if (resolved.startsWith('..') || path.posix.isAbsolute(resolved)) {
          throw new BadRequestException(`导入路径越出资产包：${specifier}`);
        }
        continue;
      }
      if (!ALLOWED_IMPORTS.has(specifier)) {
        throw new BadRequestException(`不允许的导入：${specifier}`);
      }
    }
    DYNAMIC_IMPORT.lastIndex = 0;
    if (DYNAMIC_IMPORT.test(file.content)) {
      throw new BadRequestException(`不允许动态 import()：${file.path}`);
    }
  }

  private assertSafePath(value: string): void {
    if (
      !value ||
      value.startsWith('/') ||
      value.startsWith('\\') ||
      value.includes('..') ||
      value.includes('\\') ||
      value.includes(':') ||
      !/^[a-zA-Z0-9._/-]+$/.test(value)
    ) {
      throw new BadRequestException(`不安全的文件路径：${value}`);
    }
  }

  private async writePackage(dir: string, input: PreviewCompileInput): Promise<void> {
    for (const file of input.files) {
      const target = this.safeJoin(dir, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
    const entry = this.safeEntry(input.manifest?.preview?.entry);
    await writeFile(
      path.join(dir, '__entry.tsx'),
      [
        "import * as React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        `import Preview from './${entry}';`,
        "createRoot(document.getElementById('root')).render(React.createElement(Preview));",
      ].join('\n'),
      'utf8',
    );
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new BadRequestException(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private safeEntry(entry: unknown): string {
    if (typeof entry !== 'string' || !entry || /[\r\n'"`]/.test(entry)) {
      throw new BadRequestException('预览入口路径不合法');
    }
    this.assertRelative(entry);
    return entry.replace(/^\\+/, '');
  }

  private safeJoin(base: string, relative: string): string {
    this.assertRelative(relative);
    const root = path.resolve(base);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new BadRequestException('不安全的文件路径');
    }
    return target;
  }

  private assertRelative(value: string): void {
    if (
      typeof value !== 'string' ||
      !value ||
      path.isAbsolute(value) ||
      /^[A-Za-z]:/.test(value) ||
      value.startsWith('\\\\') ||
      /\0/.test(value) ||
      value.split(/[\\/]+/).some((segment) => segment === '..')
    ) {
      throw new BadRequestException('不安全的文件路径');
    }
  }

  private async compileCss(
    appRoot: string,
    classes: string[],
    files: PreviewFile[],
  ): Promise<string> {
    const { compile: compileTailwind } = await import('@tailwindcss/node');
    const compiler = await compileTailwind('@import "tailwindcss";', {
      base: appRoot,
      onDependency() {
        // Phase 0 不跟踪依赖；资产不使用 @import。
      },
    });
    const tailwind = compiler.build(classes);
    const custom = files
      .filter((file) => file.path.endsWith('.css'))
      .map((file) => file.content)
      .join('\n');
    return [tailwind, custom].filter(Boolean).join('\n');
  }

  private async bundle(appRoot: string, dir: string): Promise<string> {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [path.join(dir, '__entry.tsx')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: ['es2020'],
      jsx: 'automatic',
      minify: true,
      absWorkingDir: dir,
      nodePaths: [path.join(appRoot, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const js = result.outputFiles?.find(
      (file) => file.path.endsWith('.js') || file.path === '<stdout>',
    )?.text;
    if (!js) throw new BadRequestException('预览编译没有产出 JS');
    return js;
  }

  private shell(css: string, js: string): string {
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const safeJs = js.replace(/<\/script/gi, '<\\/script');
    const bridge = `
(function () {
  function post(type, payload) {
    try { parent.postMessage(Object.assign({ source: 'aurum-preview', type: type }, payload), '*'); } catch (_) {}
  }
  document.addEventListener('click', function (event) {
    var element = event.target && event.target.closest ? event.target.closest('[data-part]') : null;
    if (!element) return;
    var rect = element.getBoundingClientRect();
    post('select', { part: element.getAttribute('data-part'), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }, true);
  window.addEventListener('error', function (event) { post('error', { message: String(event.message || 'preview error') }); });
})();
`;
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\" />",
      `<style>${safeCss}\nhtml,body{min-height:100%}body{margin:0;display:grid;place-items:center;background:#f8fafc;font-family:ui-sans-serif,system-ui,sans-serif}</style>`,
      '</head>',
      '<body>',
      '<div id="root"></div>',
      `<script>${bridge}</script>`,
      `<script>${safeJs}</script>`,
      '</body>',
      '</html>',
    ].join('');
  }
}
