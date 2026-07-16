'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = '加载失败', onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <AlertTriangle className="mb-4 h-12 w-12 text-destructive" />
      <h3 className="mb-1 text-lg font-medium text-destructive">出错了</h3>
      <p className="mb-4 max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="outline" size="sm">
          重试
        </Button>
      )}
    </div>
  );
}
