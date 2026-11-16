'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { isNavItemActive } from '@/lib/nav';
import { cn } from '@/lib/utils';

interface SidebarNavItemProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  collapsed?: boolean;
}

export function SidebarNavItem({ href, label, icon, collapsed }: SidebarNavItemProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = isNavItemActive(pathname, href);
  const prefetch = () => {
    if (!isActive) router.prefetch(href);
  };

  return (
    <Link
      href={href}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      onTouchStart={prefetch}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-sidebar-active text-sidebar-active-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-border',
        collapsed && 'justify-center px-2',
      )}
      title={collapsed ? label : undefined}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
    </Link>
  );
}
