'use client';

import { redirect, useSearchParams } from 'next/navigation';

/** 保留旧地址，避免仪表盘深链和已有书签失效。 */
export default function ProcessingPage() {
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  params.set('tab', 'processing');
  redirect(`/imports?${params.toString()}`);
}
