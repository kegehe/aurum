/**
 * 模块边界规则（dependency-cruiser）
 *
 * 目的：模块化单体最大的风险是边界无声地烂掉——任何模块都能 import 任何模块的内部，
 * 久而久之就退化成大泥球。这里把"模块之间只能通过对方的 service 通信"变成可执行的门禁。
 *
 * 用法：
 *   pnpm depcruise       检查（CI 会跑）
 *   pnpm depcruise:graph 输出依赖图（人工排查用）
 */

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 已知的跨模块 repository 访问（待重构）。
 *
 * 这些都是越界：绕过了对方的 service，直接读写持久化内部。
 * 修好一处就从数组里删一条；**不要在还清之前往这里加新条目**——
 * 新增的越界会被规则拦下，这正是这条门禁存在的意义。
 */
const KNOWN_CROSS_MODULE_REPOSITORY_ACCESS = [
  // design 需要来源信息，应改走 SourceService
  'apps/api/src/modules/design/design-reference.service.ts',
  // ingestion 的摄入流程直接写 resource / file / source
  'apps/api/src/modules/ingestion/ingestion.service.ts',
  // processing 的任务调度与处理器直接操作 resource / file
  'apps/api/src/modules/processing/polling-job-scheduler.ts',
  'apps/api/src/modules/processing/processing.service.ts',
  'apps/api/src/modules/processing/processors/metadata-detector.processor.ts',
  'apps/api/src/modules/processing/processors/text-extractor.processor.ts',
  'apps/api/src/modules/processing/processors/thumbnail-generator.processor.ts',
  'apps/api/src/modules/processing/processors/video-cover-generator.processor.ts',
  // resource / upload 的服务层直接读 file / category / processing 的 repository
  'apps/api/src/modules/resource/resource.service.ts',
  'apps/api/src/modules/upload/upload.service.ts',
];

/**
 * 已知存在循环依赖的模块（待重构）。
 *
 * processing ↔ resource 目前是双向的，两边都用 forwardRef 打了补丁（所以能跑），
 * 但耦合本身还在。根因与上面的 repository 越界是同一个：processing 侧
 * （PollingJobScheduler / 处理器 / 服务）直接读 resource 的 repository，
 * 而 resource 侧要 processing 的 JOB_SCHEDULER 入队任务。
 *
 * 解开它需要把调度器拆进独立模块、并为"更新资源处理状态"引入端口——属于独立重构。
 * 这里只豁免以这两个模块为起点的循环；**其它新引入的循环仍会被拦截**。
 */
const KNOWN_CIRCULAR_MODULES = ['processing', 'resource'];

const knownCycleStarts = KNOWN_CIRCULAR_MODULES.map(
  (moduleName) => `^apps/api/src/modules/${moduleName}/${moduleName}\\.module\\.ts$`,
).join('|');

const repositoryRule = {
  name: 'no-cross-module-repository',
  comment:
    '模块之间只应通过对方的 service 通信，不得直接引用对方的 repository（持久化内部）。' +
    '确需访问请走对方 service；确实暂时还不了的，登记到 KNOWN_CROSS_MODULE_REPOSITORY_ACCESS 并写明原因。',
  severity: 'error',
  from: {
    path: '^apps/api/src/modules/([^/]+)/',
  },
  to: {
    path: '^apps/api/src/modules/([^/]+)/.*\\.repository\\.ts$',
    // $1 引用 from.path 的捕获组：允许模块引用自己的 repository
    pathNot: '^apps/api/src/modules/$1/',
  },
};

if (KNOWN_CROSS_MODULE_REPOSITORY_ACCESS.length > 0) {
  repositoryRule.from.pathNot = KNOWN_CROSS_MODULE_REPOSITORY_ACCESS.map(escapeForRegex).join('|');
}

module.exports = {
  forbidden: [
    repositoryRule,
    {
      name: 'no-circular',
      comment: '循环依赖会让模块无法独立理解、独立测试，也无法单独复用。',
      severity: 'error',
      from: { pathNot: knownCycleStarts },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    // 不设 options.tsConfig：tsconfig extends 的相对路径会被按 CWD 解析而报错，
    // 而 API 内部 import 全是相对路径，不依赖 TS 的路径映射解析。
    reporterOptions: { text: { highlightFocused: true } },
  },
};
