'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/shared/page-header';
import IngestionTasks from '@/components/tasks/ingestion-tasks';
import ProcessingTasks from '@/components/tasks/processing-tasks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TaskTab = 'ingestion' | 'processing';

function readTab(value: string | null): TaskTab {
  return value === 'processing' ? 'processing' : 'ingestion';
}

export default function ImportsPage() {
  const searchParams = useSearchParams();
  const urlTab = readTab(searchParams.get('tab'));
  // tab 是纯前端视图状态：走 router.replace 会触发一次 RSC 导航，
  // 实测点击到高亮要 ~950ms。改用本地状态 + history.replaceState，切换是即时的。
  const [activeTab, setActiveTab] = useState<TaskTab>(urlTab);

  // 浏览器前进/后退或外部链接改 URL 时仍然跟随
  useEffect(() => {
    setActiveTab(urlTab);
  }, [urlTab]);

  const handleTabChange = (tab: string) => {
    const next = readTab(tab);
    setActiveTab(next);
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (next === 'processing') params.set('tab', next);
    else params.delete('tab');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `/imports?${query}` : '/imports');
  };

  return (
    <div>
      <PageHeader title="任务中心" description="集中查看导入和处理任务的进度、状态与失败原因" />
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList aria-label="任务类型">
          <TabsTrigger value="ingestion">导入任务</TabsTrigger>
          <TabsTrigger value="processing">处理任务</TabsTrigger>
        </TabsList>
        {/*
          两个面板保持挂载：切换时不卸载表格、不重新拉数据，也不闪骨架。
          隐藏的那个面板暂停轮询（active=false），避免后台白跑请求。
        */}
        <TabsContent value="ingestion" forceMount className="mt-6 data-[state=inactive]:hidden">
          <IngestionTasks active={activeTab === 'ingestion'} />
        </TabsContent>
        <TabsContent value="processing" forceMount className="mt-6 data-[state=inactive]:hidden">
          <ProcessingTasks active={activeTab === 'processing'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
