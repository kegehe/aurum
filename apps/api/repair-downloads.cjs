/**
 * 一次性修复脚本：重新下载所有 metadata_only 且无原文件的资源
 * 复用与 IngestionService.downloadRemoteFile 相同的下载逻辑
 */
const { PrismaClient } = require('@prisma/client');
const { SafeUrlService } = require('./dist/common/security/safe-url.service');
const { LocalStorageDriver } = require('./dist/modules/storage/local-storage.driver');
const { fetch } = require('undici');
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream, createReadStream } = require('node:fs');
const { unlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const prisma = new PrismaClient();
const safeUrl = new SafeUrlService();
const storage = new LocalStorageDriver({ get: () => process.env.STORAGE_ROOT || '../../storage' });
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// file-type v16 为 ESM-only，require 在旧版 Node 会抛 ERR_REQUIRE_ESM；
// 用动态 import（CJS 始终支持）并在 IIFE 启动时赋值。
let fileTypeFromFile = null;

/**
 * 带 SSRF 校验的下载请求：手动跟随重定向，每一跳校验目标主机为公网地址。
 * 与 IngestionService.fetchWithSsfrRedirectCheck 保持一致（代理模式下 dispatcher 不做 DNS-pinning）。
 */
async function fetchValidated(url, dispatcher, signal) {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await safeUrl.resolvePublicHost(new URL(current).hostname);
    const response = await fetch(current, {
      dispatcher,
      signal,
      redirect: 'manual',
      headers: { 'user-agent': 'aurum-downloader/0.1', accept: '*/*' },
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

async function download(resourceId, locatorId, url, remoteMeta) {
  const tempPath = path.join(os.tmpdir(), `aurum-dl-${randomUUID()}`);
  const host = new URL(url).hostname;
  const dispatcher = safeUrl.createSafeDispatcher({ headersTimeout: 30000, bodyTimeout: 120000 }, host);
  let bytes = 0;
  try {
    const signal = AbortSignal.timeout(180000);
    // 带 SSRF 校验（逐跳）的下载请求
    const response = await fetchValidated(url, dispatcher, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error(`File too large: ${declared}`);
    if (!response.body) throw new Error('Empty response body');
    const hash = createHash('sha256');
    const ws = createWriteStream(tempPath);
    let wsErr = null;
    let notifyErrorWait = null;
    const errorWait = new Promise((resolve) => { notifyErrorWait = resolve; });
    ws.on('error', (e) => { wsErr = e; notifyErrorWait?.(); });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (wsErr) throw wsErr;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error(`File exceeds limit`);
        hash.update(value);
        if (!ws.write(value)) {
          await Promise.race([
            new Promise((resolve) => ws.once('drain', resolve)),
            errorWait,
          ]);
          if (wsErr) throw wsErr;
        }
      }
    } finally {
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    }
    if (wsErr) throw wsErr;
    if (bytes === 0) throw new Error('Empty download (0 bytes)');
    const sha256 = hash.digest('hex');
    const detected = await fileTypeFromFile(tempPath).catch(() => null);
    const mime = detected?.mime ?? remoteMeta.mimeType ?? 'application/octet-stream';
    const ext = detected?.ext ?? 'jpg';
    const storageKey = storage.generateKey('original', sha256, undefined, ext);
    // 消费读流（LocalStorageDriver.put 内部 pipe）
    await storage.put(storageKey, createReadStream(tempPath));

    await prisma.$transaction(async (tx) => {
      const dup = await tx.resource.findFirst({ where: { sha256, deletedAt: null }, select: { id: true } });
      await tx.resource.update({
        where: { id: resourceId },
        data: {
          sha256, mimeType: mime, extension: ext, sizeBytes: BigInt(bytes),
          acquisitionMode: 'mirror_file', processingStatus: 'pending',
          duplicateOfId: dup && dup.id !== resourceId ? dup.id : undefined,
        },
      });
      await tx.resourceFile.create({
        data: { resourceId, fileRole: 'original', variant: '', storagePath: storageKey, mimeType: mime, extension: ext, sizeBytes: BigInt(bytes) },
      }).catch((e) => { if (!(e.code === 'P2002')) throw e; });
      if (locatorId) {
        await tx.resourceLocator.update({ where: { id: locatorId }, data: { httpStatus: 200, lastCheckedAt: new Date(), lastError: null, contentType: mime } });
      }
    });
    // 入队元数据检测（缩略图链式）——与 PollingJobScheduler.enqueue 的幂等语义一致：
    // 已有同资源同类型 pending/processing 任务则跳过，避免重复堆积任务
    const existingJob = await prisma.processingJob.findFirst({
      where: { resourceId, jobType: 'detect_metadata', status: { in: ['pending', 'processing'] } },
      select: { id: true },
    });
    if (!existingJob) {
      await prisma.processingJob.create({
        data: { resourceId, jobType: 'detect_metadata', status: 'pending' },
      });
    }
    return { ok: true, bytes };
  } catch (e) {
    await prisma.resourceLocator.update({ where: { id: locatorId }, data: { lastError: e.message, lastCheckedAt: new Date() } }).catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    await dispatcher.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

(async () => {
  // file-type v16 为 ESM-only，用动态 import（CJS 始终支持）
  ({ fileTypeFromFile } = await import('file-type'));
  const targets = await prisma.resource.findMany({
    where: { acquisitionMode: 'metadata_only' },
    include: { locators: { where: { locatorType: 'download' }, take: 1 } },
  });
  console.log(`Found ${targets.length} metadata_only resources to retry`);
  let ok = 0, fail = 0;
  for (const r of targets) {
    const loc = r.locators[0];
    if (!loc) { console.log(`  skip ${r.title}: no download locator`); continue; }
    const result = await download(r.id, loc.id, loc.url, r);
    if (result.ok) { ok++; console.log(`  OK  ${r.title} (${result.bytes} bytes)`); }
    else { fail++; console.log(`  FAIL ${r.title}: ${result.error}`); }
  }
  console.log(`\nDone: ${ok} downloaded, ${fail} failed`);
  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
