'use client';

import { useState, useEffect } from 'react';

/**
 * 防抖 Hook：value 延迟 delay 毫秒后更新 debouncedValue
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
