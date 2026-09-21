'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/shared/page-header';
import IngestionTasks from '@/components/tasks/ingestion-tasks';
import ProcessingTasks from '@/components/tasks/processing-tasks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function ImportsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') === 'processing' ? 'processing' : 'ingestion';

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'processing') {
      params.set('tab', tab);
    } else {
      params.delete('tab');
    }
    router.replace(`/imports${params.size ? `?${params.toString()}` : ''}`);
  };

  return (
    <div>
      <PageHeader title="任务中心" description="集中查看导入和处理任务的进度、状态与失败原因" />
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList aria-label="任务类型">
          <TabsTrigger value="ingestion">导入任务</TabsTrigger>
          <TabsTrigger value="processing">处理任务</TabsTrigger>
        </TabsList>
        <TabsContent value="ingestion" className="mt-6">
          <IngestionTasks />
        </TabsContent>
        <TabsContent value="processing" className="mt-6">
          <ProcessingTasks />
        </TabsContent>
      </Tabs>
    </div>
  );
}
