import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsistencyRepository } from './repositories/consistency.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';

export interface ConsistencyReport {
  checkedAt: string;
  databaseFileCount: number;
  storageFileCount: number;
  missingStorageFiles: string[];
  orphanStorageFiles: string[];
  expiredTempFiles: string[];
  summary: {
    missingStorageFiles: number;
    orphanStorageFiles: number;
    expiredTempFiles: number;
  };
}

@Injectable()
export class ConsistencyService {
  constructor(
    private readonly consistencyRepo: ConsistencyRepository,
    private readonly config: ConfigService,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
  ) {}

  async check(): Promise<ConsistencyReport> {
    const [dbPaths, storageObjects] = await Promise.all([
      this.consistencyRepo.listResourceFilePaths(),
      this.storage.listObjects(),
    ]);
    const storageKeys = storageObjects.map((object) => object.key);

    const dbPathSet = new Set(dbPaths);
    const storageKeySet = new Set(storageKeys);
    const now = Date.now();
    const tempTtlMs = this.config.get<number>('upload.tempTtlSeconds', 3600) * 1000;

    const missingStorageFiles = dbPaths.filter((path) => !storageKeySet.has(path));
    const orphanStorageFiles = storageKeys.filter(
      (key) => !dbPathSet.has(key) && !isExemptFromOrphanReport(key),
    );
    const expiredTempFiles = storageObjects
      .filter(
        (object) => object.key.startsWith('temp/') && now - object.modifiedAt.getTime() > tempTtlMs,
      )
      .map((object) => object.key);

    return {
      checkedAt: new Date(now).toISOString(),
      databaseFileCount: dbPaths.length,
      storageFileCount: storageKeys.length,
      missingStorageFiles,
      orphanStorageFiles,
      expiredTempFiles,
      summary: {
        missingStorageFiles: missingStorageFiles.length,
        orphanStorageFiles: orphanStorageFiles.length,
        expiredTempFiles: expiredTempFiles.length,
      },
    };
  }
}

/**
 * 是否豁免"孤儿文件"上报。
 *
 * 现在有两类：
 * - `temp/`：上传中转，由 temp-cleanup-cron 负责回收
 * - `design-previews/`、`design-diffs/`：设计运营台的渲染产物。它们的归属记录在
 *   PreviewSnapshot / 渲染任务 result 里，不在 resourceFile 表——而本模块只比对
 *   resourceFile.storagePath，所以这些文件会被无条件算成孤儿。候选删除会回收
 *   自己的产物，这里豁免只是为了不产生持续噪音。
 *
 * 注意本模块**只报告不清理**，所以豁免不会导致文件被漏删。
 */
function isExemptFromOrphanReport(key: string): boolean {
  return (
    key.startsWith('temp/') || key.startsWith('design-previews/') || key.startsWith('design-diffs/')
  );
}
