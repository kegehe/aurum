'use client';

import { Menu, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TopBarProps {
  onMenuClick?: () => void;
  showMenuButton?: boolean;
}

export function TopBar({ onMenuClick, showMenuButton }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-background px-4">
      {/* 移动端菜单按钮 */}
      {showMenuButton && (
        <Button variant="ghost" size="icon" onClick={onMenuClick} className="md:hidden">
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {/* 搜索区域 */}
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="搜索资源..."
          className="pl-8"
        />
      </div>

      {/* 上传按钮 */}
      <Button asChild size="sm" className="gap-1">
        <Link href="/upload">
          <Upload className="h-4 w-4" />
          <span className="hidden sm:inline">上传</span>
        </Link>
      </Button>
    </header>
  );
}
