import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 与 apps/web/tsconfig.json 的 paths 保持一致
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    // 组件用例要跑多轮 userEvent + 异步取数，jsdom 下实测 4~17s（并行跑时更慢），
    // 默认 5s 会让正确的用例随机超时。
    testTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
    // setup 放在 src/ 下：tsconfig 的 include 只覆盖 src/**，
    // 放在包根目录会导致 jest-dom 的匹配器类型没被 tsc 看见（typecheck 会报 TS2339）。
    setupFiles: ['./src/vitest.setup.ts'],
  },
});
