'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { MobileSidebar } from '@/components/layout/mobile-sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NAV_ITEMS } from '@/lib/constants';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      for (const group of NAV_ITEMS) {
        for (const item of group.items) {
          router.prefetch(item.href);
        }
      }
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [router]);

  return (
    <TooltipProvider>
      <div className="min-h-screen">
        {/* 桌面端侧边栏（md+ 可见） */}
        <div className="hidden md:block">
          <Sidebar />
        </div>

        {/* 移动端侧边栏 */}
        <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />

        {/* 主内容区域 */}
        <div className="md:pl-60">
          <TopBar
            showMenuButton
            onMenuClick={() => setMobileOpen(true)}
          />
          <main className="p-6">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
