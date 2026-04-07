/**
 * SEO Engine — Audit, read, and write SEO metadata
 *
 * Tools:
 *   sm_audit_seo      — Bulk SEO audit on a collection with scoring
 *   sm_get_seo_meta   — Read SEO meta for a document
 *   sm_update_seo_meta — Write/update SEO meta with auto score recalculation
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';
import { enforceGovernance, loadGovernanceConfig } from '../shared/governance.js';
import type { SeoCheck } from '../types.js';

// ============================================================
// SEO scoring logic
// ============================================================

function computeSeoScore(meta: {
  meta_title?: string | null;
  meta_description?: string | null;
  focus_keyword?: string | null;
}): { score: number; checks: SeoCheck[] } {
  const checks: SeoCheck[] = [];
  let score = 100;

  // meta_title
  const title = meta.meta_title?.trim();
  if (!title) {
    checks.push({ name: 'meta_title_present', status: 'fail', penalty: 30, message: 'Meta title is missing' });
    score -= 30;
  } else if (title.length < 30) {
    checks.push({ name: 'meta_title_length', status: 'warning', penalty: 10, message: `Meta title too short (${title.length} chars, min 30)` });
    score -= 10;
  } else if (title.length > 60) {
    checks.push({ name: 'meta_title_length', status: 'warning', penalty: 10, message: `Meta title too long (${title.length} chars, max 60)` });
    score -= 10;
  } else {
    checks.push({ name: 'meta_title_length', status: 'pass', penalty: 0, message: `Meta title OK (${title.length} chars)` });
  }

  // meta_description
  const desc = meta.meta_description?.trim();
  if (!desc) {
    checks.push({ name: 'meta_description_present', status: 'fail', penalty: 30, message: 'Meta description is missing' });
    score -= 30;
  } else if (desc.length < 120) {
    checks.push({ name: 'meta_description_length', status: 'warning', penalty: 10, message: `Meta description too short (${desc.length} chars, min 120)` });
    score -= 10;
  } else if (desc.length > 160) {
    checks.push({ name: 'meta_description_length', status: 'warning', penalty: 10, message: `Meta description too long (${desc.length} chars, max 160)` });
    score -= 10;
  } else {
    checks.push({ name: 'meta_description_length', status: 'pass', penalty: 0, message: `Meta description OK (${desc.length} chars)` });
  }

  // focus_keyword
  const keyword = meta.focus_keyword?.trim();
  if (!keyword) {
    checks.push({ name: 'focus_keyword_present', status: 'fail', penalty: 20, message: 'Focus keyword is missing' });
    score -= 20;
  } else {
    checks.push({ name: 'focus_keyword_present', status: 'pass', penalty: 0, message: `Focus keyword: "${keyword}"` });

    // Check keyword in title
    if (title && !title.toLowerCase().includes(keyword.toLowerCase())) {
      checks.push({ name: 'keyword_in_title', status: 'fail', penalty: 10, message: 'Focus keyword not found in meta title' });
      score -= 10;
    } else if (title) {
      checks.push({ name: 'keyword_in_title', status: 'pass', penalty: 0, message: 'Focus keyword found in meta title' });
    }
  }

  return { score: Math.max(0, score), checks };
}

// ============================================================
// Register SEO tools
// ============================================================

export function registerSeoTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_audit_seo
  // ----------------------------------------------------------
  server.registerTool(
    'sm_audit_seo',
    {
      title: 'Audit SEO',
      description: `Bulk SEO audit on a collection. Scores every document's SEO meta (title, description, keyword) and stores the result in sm_seo_meta + sm_seo_history.

Scoring:
  - meta_title missing: -30 | too short (<30) or too long (>60): -10
  - meta_description missing: -30 | too short (<120) or too long (>160): -10
  - focus_keyword missing: -20
  - focus_keyword not in meta_title: -10
  - Score = 100 + penalties (min 0)

Args:
  - collection: Collection name
  - locale: Locale to audit (default "fr")
  - limit: Max documents to audit (default 50)

Returns:
  - avg_score, distribution, top/bottom pages, issue counts`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        locale: z.string().default('fr').describe('Locale to audit'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max documents'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, locale, limit }) => {
      return withAudit('sm_audit_seo', 'audit', context.getActiveTargetName(), {
        collection,
        params: { collection, locale, limit },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // 1. Fetch documents
        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select('id, ' + (config.slug_field !== 'id' ? config.slug_field + ', ' : '') + (config.display_field ? config.display_field + ', ' : '') + 'created_at')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (docsErr) throw new Error(`Failed to fetch documents: ${docsErr.message}`);
        if (!docs || docs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, locale, total: 0, message: 'No documents found.' }, null, 2) }],
          };
        }

        // 2. Fetch existing SEO meta for all docs
        const docIds = (docs as unknown as Record<string, unknown>[]).map(d => d.id as string);
        const { data: existingSeo } = await client
          .from('sm_seo_meta')
          .select('*')
          .eq('page_type', collection)
          .eq('locale', locale)
          .in('page_id', docIds);

        const seoByPageId = new Map<string, Record<string, unknown>>();
        for (const row of (existingSeo || []) as Record<string, unknown>[]) {
          seoByPageId.set(row.page_id as string, row);
        }

        // 3. Score each document
        const results: {
          id: string;
          slug: string;
          name: string;
          score: number;
          checks: SeoCheck[];
          had_meta: boolean;
        }[] = [];

        const issueCounts: Record<string, number> = {};

        for (const doc of docs as unknown as Record<string, unknown>[]) {
          const docId = doc.id as string;
          const slug = (config.slug_field !== 'id' ? doc[config.slug_field] : doc.id) as string;
          const name = (config.display_field ? doc[config.display_field] : slug) as string;
          const existing = seoByPageId.get(docId);

          const { score, checks } = computeSeoScore({
            meta_title: existing?.meta_title as string | null,
            meta_description: existing?.meta_description as string | null,
            focus_keyword: existing?.focus_keyword as string | null,
          });

          // Count issues
          for (const check of checks) {
            if (check.status !== 'pass') {
              issueCounts[check.name] = (issueCounts[check.name] || 0) + 1;
            }
          }

          // 4. Upsert score into sm_seo_meta
          const scoreDetails: Record<string, number> = {};
          for (const check of checks) {
            scoreDetails[check.name] = check.penalty;
          }

          if (existing) {
            await client
              .from('sm_seo_meta')
              .update({
                seo_score: score,
                score_details: scoreDetails,
                last_audit: new Date().toISOString(),
              })
              .eq('id', existing.id);
          } else {
            await client
              .from('sm_seo_meta')
              .insert({
                page_type: collection,
                page_id: docId,
                locale,
                meta_title: null,
                meta_description: null,
                focus_keyword: null,
                canonical: null,
                og_title: null,
                og_description: null,
                og_image: null,
                noindex: false,
                nofollow: false,
                seo_score: score,
                score_details: scoreDetails,
                last_audit: new Date().toISOString(),
              });
          }

          results.push({ id: docId, slug, name, score, checks, had_meta: !!existing });
        }

        // 5. Store snapshot in sm_seo_history
        const scores = results.map(r => r.score);
        const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

        try {
          await client.from('sm_seo_history').insert({
            collection,
            locale,
            audited_at: new Date().toISOString(),
            document_count: results.length,
            avg_score: avgScore,
            min_score: Math.min(...scores),
            max_score: Math.max(...scores),
            distribution: {
              excellent: scores.filter(s => s >= 80).length,
              good: scores.filter(s => s >= 50 && s < 80).length,
              poor: scores.filter(s => s >= 20 && s < 50).length,
              critical: scores.filter(s => s < 20).length,
            },
            issue_counts: issueCounts,
          });
        } catch {
          // sm_seo_history table might not exist yet — not fatal
        }

        // 6. Build output
        const sorted = [...results].sort((a, b) => a.score - b.score);
        const output = {
          collection,
          locale,
          total_audited: results.length,
          avg_score: avgScore,
          min_score: Math.min(...scores),
          max_score: Math.max(...scores),
          distribution: {
            excellent: scores.filter(s => s >= 80).length,
            good: scores.filter(s => s >= 50 && s < 80).length,
            poor: scores.filter(s => s >= 20 && s < 50).length,
            critical: scores.filter(s => s < 20).length,
          },
          issue_counts: issueCounts,
          bottom_5: sorted.slice(0, 5).map(r => ({
            slug: r.slug,
            name: r.name,
            score: r.score,
            issues: r.checks.filter(c => c.status !== 'pass').map(c => c.message),
          })),
          top_5: sorted.slice(-5).reverse().map(r => ({
            slug: r.slug,
            name: r.name,
            score: r.score,
          })),
          documents_without_meta: results.filter(r => !r.had_meta).length,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_get_seo_meta
  // ----------------------------------------------------------
  server.registerTool(
    'sm_get_seo_meta',
    {
      title: 'Get SEO Meta',
      description: `Read SEO metadata for a specific document from sm_seo_meta.

Args:
  - collection: Collection name
  - id: Document UUID or slug
  - locale: Locale (default "fr")

Returns:
  - SEO meta: meta_title, meta_description, focus_keyword, canonical, og fields, score, checks`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
        locale: z.string().default('fr').describe('Locale'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, locale }) => {
      return withAudit('sm_get_seo_meta', 'read', context.getActiveTargetName(), {
        collection,
        document_slug: id,
        params: { locale },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // Resolve slug to UUID if needed
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let pageId = id;

        if (!isUuid) {
          const { data: doc, error } = await client
            .from(config.table)
            .select('id')
            .eq(config.slug_field, id)
            .single();
          if (error || !doc) throw new Error(`Document "${id}" not found in ${collection}.`);
          pageId = (doc as Record<string, unknown>).id as string;
        }

        // Fetch SEO meta
        const { data: seo, error: seoErr } = await client
          .from('sm_seo_meta')
          .select('*')
          .eq('page_type', collection)
          .eq('page_id', pageId)
          .eq('locale', locale)
          .single();

        if (seoErr || !seo) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              document_id: pageId,
              locale,
              seo: null,
              message: 'No SEO meta found. Run sm_audit_seo or sm_update_seo_meta to create one.',
            }, null, 2) }],
          };
        }

        // Recompute live checks
        const seoRecord = seo as Record<string, unknown>;
        const { score, checks } = computeSeoScore({
          meta_title: seoRecord.meta_title as string | null,
          meta_description: seoRecord.meta_description as string | null,
          focus_keyword: seoRecord.focus_keyword as string | null,
        });

        const output = {
          collection,
          document_id: pageId,
          locale,
          seo: seoRecord,
          live_score: score,
          checks,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_update_seo_meta
  // ----------------------------------------------------------
  server.registerTool(
    'sm_update_seo_meta',
    {
      title: 'Update SEO Meta',
      description: `Write or update SEO metadata for a document. Automatically recalculates the SEO score after update.

Args:
  - collection: Collection name
  - id: Document UUID or slug
  - locale: Locale (default "fr")
  - data: Object with fields to update: meta_title, meta_description, focus_keyword, canonical, og_title, og_description, og_image, noindex, nofollow

Returns:
  - Updated SEO meta with recalculated score and checks`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
        locale: z.string().default('fr').describe('Locale'),
        data: z.object({
          meta_title: z.string().optional(),
          meta_description: z.string().optional(),
          focus_keyword: z.string().optional(),
          canonical: z.string().optional(),
          og_title: z.string().optional(),
          og_description: z.string().optional(),
          og_image: z.string().optional(),
          noindex: z.boolean().optional(),
          nofollow: z.boolean().optional(),
        }).describe('SEO fields to update'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, locale, data }) => {
      const governance = loadGovernanceConfig();
      enforceGovernance('sm_update_seo_meta', governance);

      return withAudit('sm_update_seo_meta', 'update', context.getActiveTargetName(), {
        collection,
        document_slug: id,
        params: { locale, fields_changed: Object.keys(data) },
        changes: data as Record<string, unknown>,
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // Resolve slug to UUID
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let pageId = id;

        if (!isUuid) {
          const { data: doc, error } = await client
            .from(config.table)
            .select('id')
            .eq(config.slug_field, id)
            .single();
          if (error || !doc) throw new Error(`Document "${id}" not found in ${collection}.`);
          pageId = (doc as Record<string, unknown>).id as string;
        }

        // Check if entry exists
        const { data: existing } = await client
          .from('sm_seo_meta')
          .select('*')
          .eq('page_type', collection)
          .eq('page_id', pageId)
          .eq('locale', locale)
          .single();

        // Merge with existing values for score computation
        const merged = {
          meta_title: data.meta_title ?? (existing as Record<string, unknown> | null)?.meta_title as string | null ?? null,
          meta_description: data.meta_description ?? (existing as Record<string, unknown> | null)?.meta_description as string | null ?? null,
          focus_keyword: data.focus_keyword ?? (existing as Record<string, unknown> | null)?.focus_keyword as string | null ?? null,
        };

        const { score, checks } = computeSeoScore(merged);
        const scoreDetails: Record<string, number> = {};
        for (const check of checks) {
          scoreDetails[check.name] = check.penalty;
        }

        const seoData = {
          ...data,
          seo_score: score,
          score_details: scoreDetails,
          last_audit: new Date().toISOString(),
        };

        let result: Record<string, unknown>;

        if (existing) {
          const { data: updated, error } = await client
            .from('sm_seo_meta')
            .update(seoData)
            .eq('id', (existing as Record<string, unknown>).id)
            .select()
            .single();
          if (error) throw new Error(`Update failed: ${error.message}`);
          result = updated as Record<string, unknown>;
        } else {
          const { data: created, error } = await client
            .from('sm_seo_meta')
            .insert({
              page_type: collection,
              page_id: pageId,
              locale,
              meta_title: null,
              meta_description: null,
              focus_keyword: null,
              canonical: null,
              og_title: null,
              og_description: null,
              og_image: null,
              noindex: false,
              nofollow: false,
              ...seoData,
            })
            .select()
            .single();
          if (error) throw new Error(`Create failed: ${error.message}`);
          result = created as Record<string, unknown>;
        }

        const output = {
          collection,
          document_id: pageId,
          locale,
          seo: result,
          score,
          checks,
          fields_updated: Object.keys(data),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
