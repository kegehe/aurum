import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// @testing-library/react 的自动清理依赖 vitest 的 globals: true；
// 本仓库没有开 globals（显式 import 更清晰），所以这里手动挂 afterEach。
// 不挂的话每个用例的 DOM 会累积，断言可能在上一个用例的残留节点上误判为通过。
afterEach(cleanup);
