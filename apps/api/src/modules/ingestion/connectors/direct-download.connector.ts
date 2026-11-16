import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch, type Dispatcher } from 'undici';
import fileType from 'file-type';
import { FileRole, ResourceType } from '../../../common/constants/enums';
import { SafeUrlService } from '../../../common/security/safe-url.service';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { inferResourceType } from '../../upload/resource-type.util';

/** 跟随重定向的最大跳数（与 SafeUrlService.fetchHtml 一致） */
const MAX_REDIRECTS = 5;
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 120_000;

export interface DirectDownloadInput {
  /** 远端文件地址 */
  url: string;
  /** 来源声明的资源类型，用于判断内容是否必须是真实媒体文件 */
  expectedResourceType: string;
  /** 来源声明的 MIME（魔数无法识别时回退） */
  declaredMimeType?: string | null;
  /** 来源配置的下载子目录，作为存储 key 的前缀 */
  downloadDirectory?: string | null;
  /** 取消信号：中止正在进行的下载 */
  signal?: AbortSignal;
  /** 每个阻塞点前的检查回调，用于任务租约心跳 / 取消检查 */
  onCheckpoint?: () => Promise<void>;
}

export interface DirectDownloadResult {
  /** 已写入正式存储的对象 key */
  storageKey: string;
  sha256: string;
  mimeType: string;
  extension: string;
  resourceType: string;
  sizeBytes: number;
}

/**
 * 直连下载器：把一个远端 URL 安全地取回本地存储，只负责"取文件"，
 * 不负责资源记录、任务状态与调度（那些属于 IngestionService）。
 *
 * 之所以独立成模块：来源同步、单资源镜像、以及后续的批量下载 / 独立 Worker
 * 都需要同一份"带 SSRF 防护的下载"实现，重复实现会让安全边界出现分歧。
 */
@Injectable()
export class DirectDownloadConnector {
  constructor(
    private readonly safeUrl: SafeUrlService,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 下载并落盘。
   *
   * 失败一律抛错，由调用方决定如何记录（locator.lastError / 任务失败），
   * 错误文本即用户可见的原因。
   *
   * 成功返回的 storageKey 归调用方所有：返回后对象已落盘，若调用方随后的
   * 取消检查 / 数据库事务失败，需要自行（按引用情况）回收该对象。
   */
  async download(input: DirectDownloadInput): Promise<DirectDownloadResult> {
    const maxBytes = this.maxFileSizeBytes();
    const tempPath = join(tmpdir(), `aurum-dl-${randomUUID()}`);
    const dispatcher = this.createDispatcher(input.url);
    let downloadedBytes = 0;

    try {
      await input.onCheckpoint?.();
      const response = await this.fetchWithSsfrRedirectCheck(input.url, dispatcher, input.signal, {
        'user-agent': 'aurum-downloader/0.1',
        accept: '*/*',
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }

      const responseMimeType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (this.isClearlyNonFileMimeType(responseMimeType, input.expectedResourceType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Unexpected response content type: ${responseMimeType}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`File too large: ${declaredLength} bytes > ${maxBytes} limit`);
      }
      if (!response.body) throw new Error('Empty response body');

      await this.streamToTemp(response.body, tempPath, maxBytes, input, (bytes) => {
        downloadedBytes = bytes;
      });

      if (downloadedBytes === 0) throw new Error('Empty download (0 bytes)');
      const sha256 = await hashFile(tempPath);

      // 魔数识别真实 MIME（不信任远端 Content-Type）
      const detected = await fileType.fromFile(tempPath).catch(() => null);
      if (!detected && this.requiresMediaContent(input.expectedResourceType)) {
        throw new Error(
          `Downloaded content is not a recognizable ${input.expectedResourceType} file` +
            (responseMimeType ? ` (response type: ${responseMimeType})` : ''),
        );
      }
      const mimeType = detected?.mime ?? input.declaredMimeType ?? 'application/octet-stream';
      const extension = detected?.ext ?? this.extensionFromUrl(input.url) ?? 'bin';
      const resourceType = inferResourceType(mimeType, extension);

      // 写入正式存储；配置了下载目录时在角色目录前加上该自定义子目录前缀
      let storageKey = this.storage.generateKey(FileRole.original, sha256, undefined, extension);
      if (input.downloadDirectory && input.downloadDirectory.length > 0) {
        storageKey = `${input.downloadDirectory}/${storageKey}`;
      }
      await input.onCheckpoint?.();
      await this.storage.put(storageKey, createReadStream(tempPath));

      return { storageKey, sha256, mimeType, extension, resourceType, sizeBytes: downloadedBytes };
    } finally {
      await dispatcher.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }

  /** 单个远端文件的下载上限（MB → 字节） */
  maxFileSizeBytes(): number {
    return this.config.get<number>('download.maxFileSizeMB')! * 1024 * 1024;
  }

  private createDispatcher(url: string): Dispatcher {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error('Invalid download URL');
    }
    return this.safeUrl.createSafeDispatcher(
      { headersTimeout: HEADERS_TIMEOUT_MS, bodyTimeout: BODY_TIMEOUT_MS },
      hostname,
    );
  }

  /**
   * 带 SSRF 校验的下载请求：手动跟随重定向，并在每一跳校验目标主机为公网地址。
   *
   * 代理模式下 dispatcher 不做 DNS-pinning（连接由本地代理发出），
   * 若依赖 undici 的自动重定向跟随，重定向目标（可能指向内网）将绕过公网校验。
   * 与 SafeUrlService.fetchHtml / LocatorHealthChecker 的逐跳校验保持一致。
   */
  private async fetchWithSsfrRedirectCheck(
    url: string,
    dispatcher: Dispatcher,
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
  ): Promise<Response> {
    let current = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const target = new URL(current);
      // 重定向 Location 理论上可指向任意协议；undici fetch 仅支持 http/https，
      // 这里显式拦截避免把 file:// 等怪协议一路带到 fetch 才报错。
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`Unsupported protocol in download URL: ${target.protocol}`);
      }
      await this.safeUrl.resolvePublicHost(target.hostname);
      const response = await fetch(current, {
        dispatcher,
        signal,
        redirect: 'manual',
        headers,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error('Redirect response has no location');
        current = new URL(location, current).toString();
        continue;
      }
      return response;
    }
    throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
  }

  /**
   * 流式写入临时文件（同时限量），避免大文件读入内存。
   *
   * 写入流出错（临时目录不可写 / 磁盘满）通过 errorWait 立即唤醒背压等待，
   * 而不是每次背压都挂一个 once('error') 监听器——那会在多次背压时累积
   * 监听器并触发 MaxListenersExceededWarning。
   */
  private async streamToTemp(
    body: ReadableStream<Uint8Array>,
    tempPath: string,
    maxBytes: number,
    input: DirectDownloadInput,
    onBytes: (total: number) => void,
  ): Promise<void> {
    const writeStream = createWriteStream(tempPath);
    let writeStreamError: Error | null = null;
    let notifyErrorWait: (() => void) | null = null;
    const errorWait = new Promise<void>((resolve) => {
      notifyErrorWait = resolve;
    });
    writeStream.on('error', (err) => {
      writeStreamError = err;
      notifyErrorWait?.();
    });

    let downloadedBytes = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        await input.onCheckpoint?.();
        const { done, value } = await reader.read();
        if (done) break;
        await input.onCheckpoint?.();
        if (writeStreamError) throw writeStreamError;
        downloadedBytes += value.byteLength;
        onBytes(downloadedBytes);
        if (downloadedBytes > maxBytes) {
          throw new Error(`File exceeds ${maxBytes} byte limit`);
        }
        if (!writeStream.write(value)) {
          // 背压：等待 drain；若写入流出错，errorWait 会立即唤醒并抛错
          await Promise.race([
            new Promise<void>((resolve) => writeStream.once('drain', resolve)),
            errorWait,
          ]);
          if (writeStreamError) throw writeStreamError;
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writeStream.end((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
    if (writeStreamError) throw writeStreamError;
  }

  /** 文件类资源不应拿到 HTML/JSON 这类接口响应 */
  private isClearlyNonFileMimeType(mimeType: string | undefined, resourceType: string): boolean {
    if (!mimeType) return false;
    if (
      mimeType === 'text/html' ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'text/xml'
    ) {
      return true;
    }
    return mimeType.startsWith('text/') && resourceType !== ResourceType.text;
  }

  private requiresMediaContent(resourceType: string): boolean {
    return resourceType === ResourceType.image || resourceType === ResourceType.video;
  }

  /** 从 URL 路径推断扩展名（小写，仅限字母数字） */
  private extensionFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
      return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
    } catch {
      return null;
    }
  }
}

/** 分块计算文件 SHA-256，避免把整个文件读进内存 */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}
