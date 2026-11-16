/**
 * @tailwindcss/node 的 package.json 使用 exports 条件导出，而 API 的
 * tsconfig 仍是 moduleResolution: node。这里只声明 Phase 0 用到的 compile 子集，
 * 运行时由 Node 正常 require。
 */
declare module '@tailwindcss/node' {
  export interface CompileOptions {
    base: string;
    from?: string;
    onDependency: (path: string) => void;
    shouldRewriteUrls?: boolean;
  }

  export function compile(
    css: string,
    options: CompileOptions,
  ): Promise<{
    build(candidates: string[]): string;
  }>;
}
