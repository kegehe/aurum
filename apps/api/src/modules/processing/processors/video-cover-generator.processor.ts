import { Injectable, Inject, Logger } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import { IJobProcessor } from '../interfaces/job-processor.interface';
import { streamStorageToTemp } from '../temp-file.util';
import { runFfmpegCommand } from '../ffmpeg.util';
import { ResourceRepository } from '../../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../../file/repositories/resource-file.repository';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { FileRole, JobType } from '../../../common/constants/enums';

/** 常规视频的截帧位置（秒） */
const DEFAULT_SEEK_SECONDS = 1;
/** 短于该时长的视频改为截取中点，避免 -ss 越过末尾截不到画面 */
const SHORT_VIDEO_THRESHOLD_SECONDS = 1.5;

/**
 * 视频封面生成处理器
 *
 * 使用 FFmpeg 从视频约第 1 秒截取一帧作为封面图（JPEG）。
 * 时长不足 1.5 秒的视频改为截取中点：`-ss 1` 会越过末尾，
 * ffmpeg 报 “Nothing was written into output file” 且不产出文件。
 * 首次截帧失败时回退到首帧再试一次，覆盖时长字段缺失或失真的情况。
 * 封面作为派生文件（ResourceFile, fileRole=thumbnail）存入 storage。
 */
@Injectable()
export class VideoCoverGenerator implements IJobProcessor {
  readonly jobType = JobType.generate_video_cover;
  private readonly logger = new Logger(VideoCoverGenerator.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
  ) {}

  async process(resourceId: string, _jobId: string): Promise<void> {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    const originalFile = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.original);
    if (!originalFile) {
      throw new Error(`No original file for ${resourceId}`);
    }

    // 流式下载到临时文件（FFmpeg 需要文件路径，不能直接用流）
    const tmpIn = await streamStorageToTemp(this.storage, originalFile.storagePath, 'vcover-in');
    const tmpOut = path.join(os.tmpdir(), `vcover-out-${randomUUID()}.jpg`);

    try {
      const seekSeconds = resolveCoverSeekSeconds(toDurationSeconds(resource.durationSeconds));
      // 首选按估算位置截帧；失败则回退到首帧（任何有画面的视频都能截到）
      const attempts = seekSeconds > 0 ? [seekSeconds, 0] : [0];
      const { stats, usedSeek, failures } = await this.captureFirstAvailableFrame(
        tmpIn,
        tmpOut,
        attempts,
        resourceId,
      );
      if (failures.length > 0) {
        // 保留首选位置失败的真实原因，否则线上无从判断为什么退到首帧
        this.logger.warn(
          `Video cover for ${resourceId} captured at ${usedSeek}s after falling back from ${seekSeconds}s: ${failures.join('; ')}`,
        );
      }

      // 生成 storage key 并写入正式存储
      const hash = resource.sha256!;
      const storageKey = this.storage.generateKey(FileRole.thumbnail, hash, undefined, 'jpg');

      const stream = createReadStream(tmpOut);
      await this.storage.put(storageKey, stream);

      // 创建派生文件记录（幂等：已存在则跳过）
      const existing = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.thumbnail);
      if (!existing) {
        await this.fileRepo.create({
          resource: { connect: { id: resourceId } },
          fileRole: FileRole.thumbnail,
          variant: '',
          storagePath: storageKey,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          sizeBytes: BigInt(stats.size),
        });
      }

      this.logger.log(
        `Video cover generated for resource ${resourceId} at ${usedSeek}s (${stats.size} bytes)`,
      );
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpOut).catch(() => {});
    }
  }

  /**
   * 依次尝试各个 seek 位置截帧，返回第一个产出非空文件的结果。
   * 成功时同时带回此前尝试的失败原因（供调用方记录回退日志）；
   * 全部失败时抛出包含每次失败原因的聚合错误。
   */
  private async captureFirstAvailableFrame(
    input: string,
    output: string,
    attempts: number[],
    resourceId: string,
  ): Promise<{ stats: Stats; usedSeek: number; failures: string[] }> {
    const failures: string[] = [];

    for (const seekSeconds of attempts) {
      // 清掉上一次尝试的残留文件，避免把旧文件误判为本次产出。
      // 只有 ENOENT 可以忽略：若文件仍被上一个未退出的 ffmpeg 占用（EPERM/EBUSY），
      // 继续复用同一路径可能把旧文件当成这次的成功产出，必须直接失败交给重试。
      try {
        await fs.unlink(output);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new Error(
            `Cannot clear previous cover output for ${resourceId} (${code ?? 'unknown'}); ` +
              'refusing to reuse the path while a previous ffmpeg may still hold it',
          );
        }
      }
      try {
        await this.captureFrame(input, output, seekSeconds);
      } catch (err) {
        failures.push(`seek ${seekSeconds}s: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      let stats: Stats | null = null;
      let statError: NodeJS.ErrnoException | null = null;
      try {
        stats = await fs.stat(output);
      } catch (err) {
        statError = err as NodeJS.ErrnoException;
      }
      if (stats && stats.size > 0) {
        return { stats, usedSeek: seekSeconds, failures };
      }
      // ENOENT 就是 ffmpeg 什么都没写；其他 stat 失败（如 Windows 上被杀软短暂锁定）要保留真实错误
      failures.push(
        statError && statError.code !== 'ENOENT'
          ? `seek ${seekSeconds}s: cannot stat output (${statError.code ?? statError.message})`
          : `seek ${seekSeconds}s: ffmpeg produced no/empty output`,
      );
    }

    throw new Error(`Failed to capture video cover for ${resourceId} (${failures.join('; ')})`);
  }

  private captureFrame(input: string, output: string, seekSeconds: number): Promise<void> {
    let command = ffmpeg(input);
    if (seekSeconds > 0) {
      command = command.seekInput(seekSeconds);
    }
    command.frames(1).output(output);
    // 超时由 runFfmpegCommand 统一 SIGKILL，避免损坏/卡住的视频让任务无限挂起
    return runFfmpegCommand(command, 'FFmpeg frame capture');
  }
}

/** Prisma Decimal / number / null → 有限非负秒；NaN / Infinity / 负数等无效值返回 null */
function toDurationSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * 选择截帧位置：
 * - 时长为 0（metadata-detector 视为有效值）：只能截首帧，不再尝试其他位置
 * - 时长已知且不超过阈值：取中点（0.5s → 0.25s），保证落在视频范围内
 * - 时长未知或较长：沿用第 1 秒（失败时由调用方回退首帧）
 */
function resolveCoverSeekSeconds(durationSeconds: number | null): number {
  if (durationSeconds === null) return DEFAULT_SEEK_SECONDS;
  if (durationSeconds === 0) return 0;
  if (durationSeconds <= SHORT_VIDEO_THRESHOLD_SECONDS) return durationSeconds / 2;
  return DEFAULT_SEEK_SECONDS;
}
