import { BadRequestException, Injectable } from '@nestjs/common';

const VIEWPORTS = {
  desktop: { width: 1440, height: 960 },
  tablet: { width: 1024, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export type PreviewViewport = keyof typeof VIEWPORTS;
export type PreviewState = 'default' | 'hover';

// 截图请求才加载浏览器，渲染服务启动时不再加载 playwright-core。
async function launchChromium() {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ headless: true });
}

/** Phase 0 快照：加载编译产物，按固定视口/状态截图。 */
@Injectable()
export class PreviewSnapshotService {
  async capture(
    html: string,
    viewport: PreviewViewport = 'desktop',
    state: PreviewState = 'default',
  ): Promise<Buffer> {
    if (!VIEWPORTS[viewport]) throw new BadRequestException(`未知视口：${viewport}`);
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: VIEWPORTS[viewport] });
      page.setDefaultTimeout(15_000);
      try {
        await page.route('**/*', (route) => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        // 静态产物只有 #root、没有 data-part；等根节点出现内容即可，
        // 兼容两种入口。等不到也继续截图，避免把可渲染的页面判成失败。
        await page
          .waitForSelector('[data-part=root], #root:not(:empty)', { timeout: 10_000 })
          .catch(() => undefined);
        if (state === 'hover') {
          const hoverTarget = (await page.locator('[data-part=root]').count())
            ? '[data-part=root]'
            : '#root';
          if (await page.locator(hoverTarget).count()) {
            await page.hover(hoverTarget);
            await page.waitForTimeout(150);
          }
        }
        return await page.screenshot({ type: 'png', fullPage: false, timeout: 15_000 });
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
