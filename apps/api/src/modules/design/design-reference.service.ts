import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { AcquisitionMode, SourceType } from '../../common/constants/enums';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { isUrlWithinSourceBase } from '../../common/security/source-url-policy';
import { SourceRepository } from '../source/repositories/source.repository';
import { PrismaService } from '../prisma/prisma.service';
import { DesignService } from './design.service';
import type { JsonRecord } from './design.types';

const RETENTION_DAYS = 30;
const RATE_WINDOW_MS = 60 * 1000;

/**
 * Creates an inspiration-only draft from an approved web source. Page markup is
 * deliberately discarded after extracting a small, auditable metadata profile.
 */
@Injectable()
export class DesignReferenceService {
  constructor(
    private readonly sourceRepository: SourceRepository,
    private readonly safeUrl: SafeUrlService,
    private readonly designService: DesignService,
    private readonly prisma: PrismaService,
  ) {}

  async createUrlReferenceDraft(documentId: string, rawUrl: string, sourceId: string) {
    const source = await this.sourceRepository.findById(sourceId);
    if (!source) throw new NotFoundException('Reference source does not exist');
    if (!source.enabled || !source.baseUrl) {
      throw new BadRequestException(
        'Reference source must be enabled and have an approved base URL',
      );
    }
    if (source.sourceType === SourceType.rss) {
      // RSS 来源的 baseUrl 是 Feed 地址，不是可供审批的页面路径范围：
      // 条目链接可能落在任意路径，甚至由第三方 feed 托管在别的域名。
      // 设计参考需要真实的来源范围来做条款/robots 治理，因此明确拒绝，
      // 而不是拿 Feed 地址当路径前缀（那会让所有合法链接都被误判为越界）。
      throw new BadRequestException(
        'RSS sources cannot be used as design reference sources: their base URL is a feed address, not an approved page scope',
      );
    }
    const modes = source.allowedModes.split(',').map((mode) => mode.trim());
    if (
      !modes.includes(AcquisitionMode.link_only) &&
      !modes.includes(AcquisitionMode.metadata_only)
    ) {
      throw new BadRequestException('Reference source does not permit metadata references');
    }
    const requiresApproval = source.requiresReview;
    await this.assertTermsAccepted(source.id, source.termsUrl);

    const requested = this.safeUrl.normalize(rawUrl);
    const assertInSource = async (url: URL) => this.assertInSource(source.baseUrl!, url);
    await assertInSource(requested);
    const robotsUrl = this.safeUrl.normalize(
      source.robotsUrl || new URL('/robots.txt', requested.origin).toString(),
    );
    if (robotsUrl.origin !== requested.origin) {
      throw new BadRequestException('Reference source robots URL must use the same origin');
    }
    const robots = await this.getRobots(robotsUrl, requested.origin);
    if (!isRobotsAllowed(robots, requested.pathname)) {
      throw new BadRequestException('The source robots policy does not allow this reference URL');
    }

    await this.reserveReferenceSlot(source.id, source.rateLimitPerMinute);
    try {
      const page = await this.safeUrl.fetchHtml(
        requested.toString(),
        { validateUrl: assertInSource },
        256 * 1024,
      );
      const profile = extractReferenceProfile(page.body, page.url, source.id, source.slug);
      return await this.designService.createReferenceDraft(
        documentId,
        profile,
        page.url.toString(),
        new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
        requiresApproval,
      );
    } catch (error) {
      await this.releaseReferenceSlot(source.id);
      throw error;
    }
  }

  async acceptTerms(sourceId: string, termsVersion: string, acceptedBy: string) {
    const source = await this.sourceRepository.findById(sourceId);
    if (!source?.termsUrl) throw new BadRequestException('Reference source has no terms URL');
    const version = termsVersion.trim();
    const operator = acceptedBy.trim();
    if (!version || !operator)
      throw new BadRequestException('Terms version and operator are required');
    const terms = await this.loadTerms(source.termsUrl);
    return this.sourceRepository.createDesignReferenceTermsAcceptance({
      sourceId,
      termsUrl: terms.url,
      termsVersion: version,
      termsHash: terms.hash,
      acceptedBy: operator,
    });
  }

  private assertInSource(rawBaseUrl: string, target: URL) {
    const base = this.safeUrl.normalize(rawBaseUrl);
    if (!isUrlWithinSourceBase(base, target)) {
      throw new BadRequestException('URL is outside the approved source base URL');
    }
  }

  private async getRobots(robotsUrl: URL, expectedOrigin: string) {
    const robots = await this.safeUrl.fetchText(robotsUrl.toString(), {
      validateUrl: async (url) => {
        if (url.origin !== expectedOrigin)
          throw new BadRequestException('Reference source robots URL redirected to another origin');
      },
    });
    return robots.body;
  }

  private async reserveReferenceSlot(sourceId: string, limit: number) {
    const now = Date.now();
    const cutoff = new Date(now - RATE_WINDOW_MS);
    await this.prisma.$transaction(async (tx) => {
      const incremented = await tx.designReferenceQuota.updateMany({
        where: { sourceId, windowStartedAt: { gt: cutoff }, count: { lt: limit } },
        data: { count: { increment: 1 } },
      });
      if (incremented.count === 1) return;
      const reset = await tx.designReferenceQuota.updateMany({
        where: { sourceId, windowStartedAt: { lte: cutoff } },
        data: { windowStartedAt: new Date(now), count: 1 },
      });
      if (reset.count === 1) return;
      try {
        await tx.designReferenceQuota.create({
          data: { sourceId, windowStartedAt: new Date(now), count: 1 },
        });
      } catch {
        const retried = await tx.designReferenceQuota.updateMany({
          where: { sourceId, windowStartedAt: { gt: cutoff }, count: { lt: limit } },
          data: { count: { increment: 1 } },
        });
        if (retried.count !== 1)
          throw new BadRequestException('Reference source rate limit exceeded');
      }
    });
  }

  private async releaseReferenceSlot(sourceId: string) {
    const cutoff = new Date(Date.now() - RATE_WINDOW_MS);
    await this.prisma.designReferenceQuota.updateMany({
      where: { sourceId, windowStartedAt: { gt: cutoff }, count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }

  private async assertTermsAccepted(sourceId: string, termsUrl: string | null) {
    if (!termsUrl) return;
    const terms = await this.loadTerms(termsUrl);
    const acceptance = await this.sourceRepository.findDesignReferenceTermsAcceptance(
      sourceId,
      terms.url,
      terms.hash,
    );
    if (!acceptance) {
      throw new BadRequestException(
        'Reference source terms must be explicitly accepted by an operator before use',
      );
    }
  }

  private async loadTerms(termsUrl: string) {
    const page = await this.safeUrl.fetchHtml(termsUrl, undefined, 256 * 1024);
    const url = page.url.toString();
    return {
      url,
      hash: createHash('sha256').update(`${url}\n${page.body}`).digest('hex'),
    };
  }
}

function extractReferenceProfile(
  html: string,
  pageUrl: URL,
  sourceId: string,
  sourceSlug: string,
): JsonRecord {
  const $ = cheerio.load(html);
  const pick = (selector: string, attr = 'content') =>
    $(selector).first().attr(attr)?.trim() || undefined;
  const text = (selector: string) =>
    $(selector).first().text().replace(/\s+/g, ' ').trim() || undefined;
  const truncate = (value: string | undefined, limit: number) => value?.slice(0, limit);
  const resolve = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return new URL(value, pageUrl).toString();
    } catch {
      return undefined;
    }
  };
  return {
    schema: 'aurum.reference-profile.v1',
    policy: 'inspiration_only',
    source: { id: sourceId, slug: sourceSlug, url: pageUrl.toString() },
    title: truncate(pick('meta[property="og:title"]') || text('title') || pageUrl.hostname, 255),
    description: truncate(
      pick('meta[property="og:description"]') || pick('meta[name="description"]'),
      1000,
    ),
    publisher: truncate(pick('meta[property="og:site_name"]') || pageUrl.hostname, 255),
    canonicalUrl: resolve(pick('link[rel="canonical"]', 'href')) || pageUrl.toString(),
    imageUrl: resolve(pick('meta[property="og:image"]')),
    capturedFields: ['title', 'description', 'publisher', 'canonicalUrl', 'imageUrl'],
  };
}

function isRobotsAllowed(robots: string, pathname: string): boolean {
  const groups: Array<{
    agents: string[];
    rules: Array<{ type: 'allow' | 'disallow'; path: string }>;
  }> = [];
  let current:
    { agents: string[]; rules: Array<{ type: 'allow' | 'disallow'; path: string }> } | undefined;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (
      (field === 'allow' || field === 'disallow') &&
      current &&
      current.agents.length > 0
    ) {
      current.rules.push({ type: field, path: value });
    }
  }
  const agent = 'aurum-design-reference';
  const matching = groups.filter((group) =>
    group.agents.some((name) => name === agent || name === '*'),
  );
  const exact = matching.filter((group) => group.agents.includes(agent));
  const rules = (exact.length ? exact : matching)
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path && pathname.startsWith(rule.path));
  if (!rules.length) return true;
  rules.sort(
    (left, right) => right.path.length - left.path.length || (left.type === 'allow' ? -1 : 1),
  );
  return rules[0].type === 'allow';
}
