'use client';

import { useState } from 'react';
import { Menu, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TopBarProps {
  onMenuClick?: () => void;
  showMenuButton?: boolean;
}

export function TopBar({ onMenuClick, showMenuButton }: TopBarProps) {
  const router = useRouter();
  const [keyword, setKeyword] = useState('');

  const handleSearchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = keyword.trim();
    // 跳转到资源库并携带关键词；关键词为空时仅进入资源库。
    router.push(trimmed ? `/resources?keyword=${encodeURIComponent(trimmed)}` : '/resources');
    // 提交后清空顶栏输入，避免导航到不带 keyword 的页面（如侧边栏“资源库”）后残留过期搜索词；
    // 已生效的关键词由资源库页内的搜索框展示。
    setKeyword('');
  };

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-background px-4">
      {/* 移动端菜单按钮 */}
      {showMenuButton && (
        <Button variant="ghost" size="icon" onClick={onMenuClick} className="md:hidden">
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {/* 搜索区域：回车跳转到资源库并携带关键词 */}
      <form onSubmit={handleSearchSubmit} role="search" className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索资源..."
          className="pl-8"
          aria-label="搜索资源"
        />
      </form>

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
