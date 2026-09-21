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
      (key) => !dbPathSet.has(key) && !key.startsWith('temp/'),
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
