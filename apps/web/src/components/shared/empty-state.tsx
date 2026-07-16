'use client';

import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 text-muted-foreground">
        {icon ?? <FolderOpen className="h-12 w-12" />}
      </div>
      <h3 className="mb-1 text-lg font-medium">{title}</h3>
      {description && (
        <p className="mb-4 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {action && (
        <Button onClick={action.onClick} variant="outline" size="sm">
          {action.label}
        </Button>
      )}
    </div>
  );
}
