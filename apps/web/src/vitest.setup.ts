import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// findBy* / waitFor 的默认异步预算只有 1s。页面级用例要等 mock 取数 + 多轮渲染，
// jsdom 下实测单次要 1~3s，默认值会让正确用例随机报 "Unable to find ..."。
configure({ asyncUtilTimeout: 5000 });

// @testing-library/react 的自动清理依赖 vitest 的 globals: true；
// 本仓库没有开 globals（显式 import 更清晰），所以这里手动挂 afterEach。
// 不挂的话每个用例的 DOM 会累积，断言可能在上一个用例的残留节点上误判为通过。
afterEach(cleanup);
