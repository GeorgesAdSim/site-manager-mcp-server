/**
 * Performance Engine — Core Web Vitals, image audit, bundle analysis
 *
 * Tools:
 *   sm_audit_performance — Audit Core Web Vitals via Google PageSpeed Insights
 *   sm_audit_images      — Audit images for format, size, and alt text
 *   sm_audit_bundle      — Analyze JS/CSS bundle sizes from production HTML
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';

// ============================================================
// Register Performance tools
// ============================================================

export function registerPerformanceTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_audit_performance
  // ----------------------------------------------------------
  server.registerTool(
    'sm_audit_performance',
    {
      title: 'Audit Performance (Core Web Vitals)',
      description: `Audit Core Web Vitals via Google PageSpeed Insights API. Returns performance score, LCP, CLS, INP, FCP, TTFB, Speed Index, and top improvement opportunities.

Args:
  - url: URL to audit
  - strategy: "mobile" or "desktop" (default "mobile")

Returns:
  - Performance score 0-100, core metrics with ratings, top 5 opportunities, verdict`,
      inputSchema: {
        url: z.string().url().describe('URL to audit'),
        strategy: z.enum(['mobile', 'desktop']).default('mobile').describe('Test strategy'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, strategy }) => {
      return withAudit('sm_audit_performance', 'audit', context.getActiveTargetName(), {
        params: { url, strategy },
      }, async () => {
        // Build PageSpeed Insights URL
        const apiKey = process.env.PAGESPEED_API_KEY || '';
        const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
        apiUrl.searchParams.set('url', url);
        apiUrl.searchParams.set('strategy', strategy);
        apiUrl.searchParams.set('category', 'performance');
        if (apiKey) apiUrl.searchParams.set('key', apiKey);

        const response = await fetch(apiUrl.toString(), {
          headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`PageSpeed API error: HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const lighthouse = data.lighthouseResult as Record<string, unknown> | undefined;

        if (!lighthouse) {
          throw new Error('No Lighthouse result in PageSpeed response');
        }

        const categories = lighthouse.categories as Record<string, Record<string, unknown>> | undefined;
        const audits = lighthouse.audits as Record<string, Record<string, unknown>> | undefined;

        const perfScore = Math.round(((categories?.performance?.score as number) || 0) * 100);

        // Extract core metrics
        function getMetric(id: string): { value: number; display: string; rating: string } {
          const audit = audits?.[id];
          if (!audit) return { value: 0, display: 'N/A', rating: 'unknown' };
          return {
            value: (audit.numericValue as number) || 0,
            display: (audit.displayValue as string) || 'N/A',
            rating: (audit.score as number) >= 0.9 ? 'good' : (audit.score as number) >= 0.5 ? 'needs-improvement' : 'poor',
          };
        }

        const lcp = getMetric('largest-contentful-paint');
        const cls = getMetric('cumulative-layout-shift');
        const inp = getMetric('interaction-to-next-paint');
        const fcp = getMetric('first-contentful-paint');
        const ttfb = getMetric('server-response-time');
        const speedIndex = getMetric('speed-index');

        // Extract top opportunities
        const opportunityIds = [
          'render-blocking-resources',
          'unused-javascript',
          'unused-css-rules',
          'modern-image-formats',
          'uses-optimized-images',
          'efficient-animated-content',
          'uses-text-compression',
          'uses-responsive-images',
          'offscreen-images',
          'unminified-javascript',
          'unminified-css',
          'uses-long-cache-ttl',
          'total-byte-weight',
          'dom-size',
          'critical-request-chains',
        ];

        const opportunities: { name: string; savings: string; score: number }[] = [];
        for (const id of opportunityIds) {
          const audit = audits?.[id];
          if (!audit) continue;
          const score = (audit.score as number) ?? 1;
          if (score < 1) {
            opportunities.push({
              name: (audit.title as string) || id,
              savings: (audit.displayValue as string) || '',
              score: Math.round(score * 100),
            });
          }
        }
        opportunities.sort((a, b) => a.score - b.score);
        const top5 = opportunities.slice(0, 5);

        // Verdict
        let verdict: string;
        if (perfScore >= 90) verdict = 'Bon — performances excellentes';
        else if (perfScore >= 50) verdict = 'À améliorer — performances moyennes';
        else verdict = 'Critique — performances insuffisantes';

        const output = {
          url,
          strategy,
          performance_score: perfScore,
          metrics: {
            lcp: { value_ms: Math.round(lcp.value), display: lcp.display, rating: lcp.rating },
            cls: { value: parseFloat((cls.value).toFixed(3)), display: cls.display, rating: cls.rating },
            inp: { value_ms: Math.round(inp.value), display: inp.display, rating: inp.rating },
            fcp: { value_ms: Math.round(fcp.value), display: fcp.display, rating: fcp.rating },
            ttfb: { value_ms: Math.round(ttfb.value), display: ttfb.display, rating: ttfb.rating },
            speed_index: { value_ms: Math.round(speedIndex.value), display: speedIndex.display, rating: speedIndex.rating },
          },
          opportunities: top5,
          verdict,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_audit_images
  // ----------------------------------------------------------
  server.registerTool(
    'sm_audit_images',
    {
      title: 'Audit Images',
      description: `Audit images for format, file size, and alt text. Checks media_items (or any media table) for optimization issues.

Args:
  - collection: Media table name (default "media_items")
  - limit: Max images to audit (default 100)

Returns:
  - Total images, format distribution, oversized count, missing alt count, total size, recommendations`,
      inputSchema: {
        collection: z.string().default('media_items').describe('Media table name'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max images to audit'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, limit }) => {
      return withAudit('sm_audit_images', 'audit', context.getActiveTargetName(), {
        params: { collection, limit },
      }, async () => {
        const client = context.getClient();

        // Fetch media items
        const { data: items, error } = await client
          .from(collection)
          .select('id, title, description, type, url, thumbnail_url, file_type, metadata')
          .limit(limit);

        if (error) throw new Error(`Failed to fetch from ${collection}: ${error.message}`);
        if (!items || items.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, total: 0, message: 'No media items found.' }, null, 2) }],
          };
        }

        const records = items as unknown as Record<string, unknown>[];

        // Analyze each image
        const formatCounts: Record<string, number> = {};
        let oversizedCount = 0;
        let criticalSizeCount = 0;
        let missingAltCount = 0;
        let totalSizeBytes = 0;
        const oversizedItems: { id: string; url: string; size_kb: number }[] = [];
        const missingAltItems: { id: string; url: string; title: string }[] = [];

        for (const item of records) {
          const itemUrl = (item.url || item.thumbnail_url || '') as string;
          const fileType = (item.file_type || item.type || '') as string;
          const title = (item.title || '') as string;
          const description = (item.description || '') as string;
          const metadata = item.metadata as Record<string, unknown> | null;

          // Detect format from URL extension or file_type
          let format = 'unknown';
          if (fileType) {
            const ft = fileType.toLowerCase();
            if (ft.includes('webp')) format = 'webp';
            else if (ft.includes('avif')) format = 'avif';
            else if (ft.includes('png')) format = 'png';
            else if (ft.includes('jpeg') || ft.includes('jpg')) format = 'jpeg';
            else if (ft.includes('svg')) format = 'svg';
            else if (ft.includes('gif')) format = 'gif';
            else if (ft.includes('video') || ft.includes('mp4')) format = 'video';
            else if (ft.includes('pdf')) format = 'pdf';
            else format = ft;
          } else if (itemUrl) {
            const ext = itemUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || '';
            if (['webp', 'avif', 'png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) {
              format = ext === 'jpg' ? 'jpeg' : ext;
            }
          }
          formatCounts[format] = (formatCounts[format] || 0) + 1;

          // Check file size from metadata or via HEAD request
          let sizeBytes = 0;
          if (metadata?.size) {
            sizeBytes = metadata.size as number;
          } else if (metadata?.file_size) {
            sizeBytes = metadata.file_size as number;
          }

          // If no size in metadata and it's an image URL, try HEAD
          if (sizeBytes === 0 && itemUrl && ['jpeg', 'png', 'webp', 'avif', 'gif'].includes(format)) {
            try {
              const headRes = await fetch(itemUrl, { method: 'HEAD' });
              const cl = headRes.headers.get('content-length');
              if (cl) sizeBytes = parseInt(cl, 10);
            } catch {
              // Skip — can't check size
            }
          }

          totalSizeBytes += sizeBytes;
          const sizeKb = Math.round(sizeBytes / 1024);

          if (sizeBytes > 1_000_000) {
            criticalSizeCount++;
            oversizedCount++;
            oversizedItems.push({ id: item.id as string, url: itemUrl, size_kb: sizeKb });
          } else if (sizeBytes > 500_000) {
            oversizedCount++;
            oversizedItems.push({ id: item.id as string, url: itemUrl, size_kb: sizeKb });
          }

          // Check alt text (title or description serve as alt)
          if (!title.trim() && !description.trim()) {
            missingAltCount++;
            if (missingAltItems.length < 10) {
              missingAltItems.push({ id: item.id as string, url: itemUrl, title });
            }
          }
        }

        // Build recommendations
        const recommendations: string[] = [];
        const imageFormats = ['jpeg', 'png', 'gif'];
        const modernFormats = ['webp', 'avif'];
        const legacyCount = imageFormats.reduce((acc, f) => acc + (formatCounts[f] || 0), 0);
        const modernCount = modernFormats.reduce((acc, f) => acc + (formatCounts[f] || 0), 0);

        if (legacyCount > 0 && modernCount < legacyCount) {
          recommendations.push(`Convert ${legacyCount} legacy images (JPEG/PNG/GIF) to WebP/AVIF for ~30-50% size reduction`);
        }
        if (oversizedCount > 0) {
          recommendations.push(`${oversizedCount} images exceed 500KB — compress or resize them`);
        }
        if (criticalSizeCount > 0) {
          recommendations.push(`${criticalSizeCount} images exceed 1MB — critical for mobile performance`);
        }
        if (missingAltCount > 0) {
          recommendations.push(`${missingAltCount} images missing alt text — add title/description for accessibility and SEO`);
        }
        if (recommendations.length === 0) {
          recommendations.push('Images look well optimized!');
        }

        const output = {
          collection,
          total_images: records.length,
          format_distribution: formatCounts,
          oversized_count: oversizedCount,
          critical_size_count: criticalSizeCount,
          missing_alt_count: missingAltCount,
          total_size_mb: Math.round(totalSizeBytes / (1024 * 1024) * 100) / 100,
          oversized_items: oversizedItems.slice(0, 10),
          missing_alt_items: missingAltItems,
          recommendations,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_audit_bundle
  // ----------------------------------------------------------
  server.registerTool(
    'sm_audit_bundle',
    {
      title: 'Audit JS/CSS Bundle',
      description: `Analyze production JS and CSS bundle sizes by parsing the HTML of a live site.

Finds all <script src> and <link rel="stylesheet"/"modulepreload"> tags, fetches their sizes via HEAD requests, and evaluates the total bundle weight.

Args:
  - url: Site URL to audit (defaults to Content Contract site URL)

Returns:
  - total_js_kb, total_css_kb, file_count, largest file, verdict, recommendations`,
      inputSchema: {
        url: z.string().url().optional().describe('Site URL (defaults to Content Contract)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      return withAudit('sm_audit_bundle', 'audit', context.getActiveTargetName(), {
        params: { url },
      }, async () => {
        const contract = await context.loadContract();
        const siteUrl = url || contract?.site?.url;
        if (!siteUrl) throw new Error('No URL provided and no site URL in Content Contract.');

        // 1. Fetch the HTML
        const response = await fetch(siteUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SiteManagerBot/1.0; +https://adsim.be)',
            'Accept': 'text/html',
          },
          redirect: 'follow',
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch ${siteUrl}: HTTP ${response.status}`);
        }

        const html = await response.text();
        const baseUrl = new URL(siteUrl);

        // 2. Find all JS and CSS files
        const assets: { url: string; type: 'js' | 'css'; size_bytes: number; size_kb: number }[] = [];

        // Helper to resolve relative URLs
        function resolveUrl(src: string): string | null {
          if (src.startsWith('http')) return src;
          if (src.startsWith('//')) return `${baseUrl.protocol}${src}`;
          if (src.startsWith('/')) return `${baseUrl.origin}${src}`;
          return null; // skip relative paths without /
        }

        // Script tags: <script src="...">
        const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
        let scriptExec;
        while ((scriptExec = scriptRegex.exec(html)) !== null) {
          const fullUrl = resolveUrl(scriptExec[1]);
          if (fullUrl) assets.push({ url: fullUrl, type: 'js', size_bytes: 0, size_kb: 0 });
        }

        // Modulepreload: <link rel="modulepreload" href="...">
        const moduleRegex = /<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
        let moduleExec;
        while ((moduleExec = moduleRegex.exec(html)) !== null) {
          const fullUrl = resolveUrl(moduleExec[1]);
          if (fullUrl && !assets.some(a => a.url === fullUrl)) {
            assets.push({ url: fullUrl, type: 'js', size_bytes: 0, size_kb: 0 });
          }
        }

        // Stylesheets: <link rel="stylesheet" href="...">
        const cssRegex = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
        let cssExec;
        while ((cssExec = cssRegex.exec(html)) !== null) {
          const fullUrl = resolveUrl(cssExec[1]);
          if (fullUrl) assets.push({ url: fullUrl, type: 'css', size_bytes: 0, size_kb: 0 });
        }

        // Also try reversed order: href before rel
        const cssRegex2 = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["'][^>]*>/gi;
        let cssExec2;
        while ((cssExec2 = cssRegex2.exec(html)) !== null) {
          const fullUrl = resolveUrl(cssExec2[1]);
          if (fullUrl && !assets.some(a => a.url === fullUrl)) {
            assets.push({ url: fullUrl, type: 'css', size_bytes: 0, size_kb: 0 });
          }
        }

        // 3. Fetch sizes via HEAD (parallel)
        await Promise.all(assets.map(async (asset) => {
          try {
            const headRes = await fetch(asset.url, { method: 'HEAD' });
            const cl = headRes.headers.get('content-length');
            if (cl) {
              asset.size_bytes = parseInt(cl, 10);
              asset.size_kb = Math.round(asset.size_bytes / 1024);
            }
          } catch {
            // Skip — can't reach asset
          }
        }));

        // 4. Analyze
        const jsAssets = assets.filter(a => a.type === 'js');
        const cssAssets = assets.filter(a => a.type === 'css');
        const totalJsKb = jsAssets.reduce((acc, a) => acc + a.size_kb, 0);
        const totalCssKb = cssAssets.reduce((acc, a) => acc + a.size_kb, 0);
        const allSorted = [...assets].sort((a, b) => b.size_bytes - a.size_bytes);
        const largest = allSorted[0] || null;

        // Verdict
        let verdict: string;
        if (totalJsKb < 200) verdict = 'Bon — bundle JS léger (< 200 KB)';
        else if (totalJsKb < 500) verdict = 'Acceptable — bundle JS moyen (200-500 KB)';
        else verdict = 'À optimiser — bundle JS lourd (> 500 KB)';

        // Recommendations
        const recommendations: string[] = [];
        if (totalJsKb > 500) recommendations.push('Consider code splitting and lazy loading heavy modules');
        if (totalJsKb > 200) recommendations.push('Review unused JavaScript with tree-shaking analysis');
        if (jsAssets.length > 10) recommendations.push(`${jsAssets.length} JS files — consider bundling to reduce HTTP requests`);
        if (totalCssKb > 100) recommendations.push('Consider purging unused CSS (PurgeCSS/Tailwind JIT)');
        if (largest && largest.size_kb > 200) recommendations.push(`Largest file (${largest.size_kb} KB) — consider splitting`);
        if (recommendations.length === 0) recommendations.push('Bundle looks well optimized!');

        const output = {
          url: siteUrl,
          total_js_kb: totalJsKb,
          total_css_kb: totalCssKb,
          total_kb: totalJsKb + totalCssKb,
          js_file_count: jsAssets.length,
          css_file_count: cssAssets.length,
          largest_file: largest ? {
            url: largest.url.split('/').pop(),
            type: largest.type,
            size_kb: largest.size_kb,
          } : null,
          files: assets.map(a => ({
            file: a.url.split('/').pop()?.split('?')[0],
            type: a.type,
            size_kb: a.size_kb,
          })).sort((a, b) => b.size_kb - a.size_kb),
          verdict,
          recommendations,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
