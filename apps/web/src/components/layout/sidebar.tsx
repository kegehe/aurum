'use client';

import {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Link,
  Tags,
  Layers,
  Cpu,
  Trash2,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { SidebarNavItem } from './sidebar-nav-item';
import { NAV_ITEMS } from '@/lib/constants';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Link,
  Tags,
  Layers,
  Cpu,
  Trash2,
};

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 z-30 flex h-screen w-60 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-active text-sidebar-active-foreground text-sm font-bold">
          R
        </div>
        <span className="font-semibold text-sidebar-foreground">资源管理</span>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-2">
        {NAV_ITEMS.map((group, groupIdx) => (
          <div key={group.group} className="mb-4">
            <h4 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.group}
            </h4>
            <nav className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const IconComp = ICON_MAP[item.icon];
                return (
                  <SidebarNavItem
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={IconComp ? <IconComp className="h-4 w-4" /> : null}
                  />
                );
              })}
            </nav>
            {groupIdx < NAV_ITEMS.length - 1 && <Separator className="mt-3" />}
          </div>
        ))}
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <p className="text-xs text-muted-foreground">资源管理平台 v0.1</p>
      </div>
    </aside>
  );
}
