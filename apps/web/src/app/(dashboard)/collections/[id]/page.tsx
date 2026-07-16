'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { LoadingState } from '@/components/shared/loading-state';
import { ResourceGrid } from '@/components/shared/resource-grid';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { getCollection, removeResourceFromCollection } from '@/lib/api/collections';
import type { CollectionDetail, ResourceListItem } from '@/lib/types';

function normalizeResource(resource: CollectionDetail['resources'][number]): ResourceListItem {
  return {
    id: resource.id,
    title: resource.title,
    description: resource.description ?? null,
    originalFilename: resource.originalFilename ?? resource.title,
    resourceType: resource.resourceType,
    mimeType: resource.mimeType,
    extension: resource.extension ?? '',
    sizeBytes: resource.sizeBytes,
    sha256: resource.sha256 ?? null,
    categoryId: resource.categoryId ?? null,
    source: resource.source ?? null,
    author: resource.author ?? null,
    licenseNote: resource.licenseNote ?? null,
    isFavorite: resource.isFavorite ?? false,
    processingStatus: resource.processingStatus,
    duplicateOfId: resource.duplicateOfId ?? null,
    width: resource.width ?? null,
    height: resource.height ?? null,
    durationSeconds: resource.durationSeconds ?? null,
    searchVector: resource.searchVector ?? null,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    deletedAt: resource.deletedAt ?? null,
  };
}

export default function CollectionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ResourceListItem | null>(null);

  const fetchCollection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCollection(await getCollection(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCollection();
  }, [fetchCollection]);

  const resources = useMemo(
    () => collection?.resources.map(normalizeResource) ?? [],
    [collection],
  );

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeResourceFromCollection(id, removeTarget.id);
      toast.success('已从集合移除');
      setRemoveTarget(null);
      await fetchCollection();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移除失败');
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="集合详情" description="查看和管理集合中的资源" />
        <LoadingState variant="card" count={8} />
      </div>
    );
  }

  if (error || !collection) {
    return (
      <div>
        <PageHeader title="集合详情" description="查看和管理集合中的资源">
          <Button variant="outline" size="sm" className="gap-1" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
        </PageHeader>
        <ErrorState message={error ?? '集合不存在'} onRetry={fetchCollection} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={collection.name}
        description={collection.description || `共 ${resources.length} 个资源`}
      >
        <Button variant="outline" size="sm" className="gap-1" asChild>
          <Link href="/collections">
            <ArrowLeft className="h-4 w-4" />
            返回集合
          </Link>
        </Button>
      </PageHeader>

      {resources.length === 0 ? (
        <EmptyState title="集合为空" description="从资源库中选择资源加入集合" />
      ) : (
        <ResourceGrid
          resources={resources}
          onDelete={(resourceId) => {
            const target = resources.find((resource) => resource.id === resourceId);
            if (target) setRemoveTarget(target);
          }}
        />
      )}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="从集合移除"
        description={`确定要将 "${removeTarget?.title || removeTarget?.originalFilename}" 从集合中移除吗？资源本身不会被删除。`}
        confirmLabel="移除"
        variant="destructive"
        onConfirm={handleRemove}
      />
    </div>
  );
}
