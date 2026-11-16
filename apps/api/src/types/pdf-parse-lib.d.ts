/**
 * pdf-parse 的顶层入口 index.js 在 module.parent 为空时会执行自带的 demo，
 * 读取包内并不存在的测试 PDF（test/data/05-versions-space.pdf）并抛错。
 * ESM 转译、打包器或 vitest 加载时 module.parent 恰好为空，导入即崩，
 * 因此文本提取直接引用库实现入口，这里补上类型声明。
 *
 * 入参声明为 Uint8Array：pdf.js 1.10 对 Buffer 入参有缺陷，小 PDF（实测 2KB 以下）
 * 会被解析成错位数据（报 bad XRef entry），传 Uint8Array 才能正确读取。
 */
declare module 'pdf-parse/lib/pdf-parse' {
  import type { Options, Result } from 'pdf-parse';

  function pdfParse(dataBuffer: Uint8Array, options?: Options): Promise<Result>;

  export = pdfParse;
}
