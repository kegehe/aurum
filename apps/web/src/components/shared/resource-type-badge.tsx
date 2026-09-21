import type { ResourceType } from '@aurum/shared-types';
import { Badge } from '@/components/ui/badge';
import { RESOURCE_TYPE_LABELS } from '@/lib/constants';

interface ResourceTypeBadgeProps {
  type: ResourceType;
  className?: string;
}

export function ResourceTypeBadge({ type, className }: ResourceTypeBadgeProps) {
  return (
    <Badge variant="secondary" className={className}>
      {RESOURCE_TYPE_LABELS[type] ?? type}
    </Badge>
  );
}
