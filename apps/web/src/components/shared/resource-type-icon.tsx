'use client';

import {
  Image,
  Video,
  Music,
  FileText,
  File,
  Archive,
  Box,
  Type,
  Gamepad2,
  FileQuestion,
} from 'lucide-react';
import type { ResourceType } from '@resource-service/shared-types';

const ICON_MAP: Record<ResourceType, React.ComponentType<{ className?: string }>> = {
  image: Image,
  video: Video,
  audio: Music,
  text: FileText,
  document: File,
  archive: Archive,
  model3d: Box,
  font: Type,
  game_asset: Gamepad2,
  other: FileQuestion,
};

interface ResourceTypeIconProps {
  type: ResourceType;
  className?: string;
}

export function ResourceTypeIcon({ type, className }: ResourceTypeIconProps) {
  const Icon = ICON_MAP[type] ?? FileQuestion;
  return <Icon className={className} />;
}
