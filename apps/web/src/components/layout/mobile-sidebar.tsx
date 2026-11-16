'use client';

import {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Link as LinkIcon,
  Download,
  Cpu,
  Trash2,
  Wand2,
  Library,
  BarChart3,
  Settings,
  Sparkles,
  ClipboardCheck,
  Palette,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { AurumMark } from '@/components/brand/aurum-mark';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from '@/lib/constants';
import { isNavItemActive } from '@/lib/nav';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Link: LinkIcon,
  Download,
  Cpu,
  Trash2,
  Wand2,
  Library,
  BarChart3,
  Settings,
  Sparkles,
  ClipboardCheck,
  Palette,
  ShieldCheck,
};

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function MobileSidebar({ open, onClose }: MobileSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <AurumMark className="h-7 w-7" title="Aurum" />
            <span>Aurum</span>
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 px-3 py-2">
          {NAV_ITEMS.map((group, groupIdx) => (
            <div key={group.group} className="mb-4">
              <h4 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.group}
              </h4>
              <nav className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const IconComp = ICON_MAP[item.icon];
                  const isActive = isNavItemActive(pathname, item.href);
                  const prefetch = () => {
                    if (!isActive) router.prefetch(item.href);
                  };
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onMouseEnter={prefetch}
                      onFocus={prefetch}
                      onTouchStart={prefetch}
                      onClick={onClose}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-sidebar-active text-sidebar-active-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-border',
                      )}
                    >
                      {IconComp && <IconComp className="h-4 w-4" />}
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
              {groupIdx < NAV_ITEMS.length - 1 && <Separator className="mt-3" />}
            </div>
          ))}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
