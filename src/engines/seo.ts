/**
 * SEO Engine — Audit, read, and write SEO metadata + structured data + internal linking
 *
 * Tools:
 *   sm_audit_seo            — Bulk SEO audit on a collection with scoring
 *   sm_get_seo_meta         — Read SEO meta for a document
 *   sm_update_seo_meta      — Write/update SEO meta with auto score recalculation
 *   sm_generate_schema      — Generate JSON-LD Product schema for a document
 *   sm_suggest_internal_links — Suggest internal links between same-category documents
 *   sm_auto_fix_seo         — Auto-audit and fix all SEO for a collection in one call
 *   sm_score_global         — Global site score 0-100 aggregating all SEO dimensions
 *   sm_check_rendering      — Compare HTML rendered meta vs DB meta (SSR injection check)
 *   sm_generate_canonical   — Generate and persist canonical URLs + hreflang for a collection
 *   sm_find_orphan_pages    — Find pages with no inbound internal links
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';
import { enforceGovernance, loadGovernanceConfig } from '../shared/governance.js';
import { getLocalized, isUuid, fetchCategories } from '../shared/helpers.js';
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
        const idIsUuid = isUuid(id);
        let pageId = id;

        if (!idIsUuid) {
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
        const idIsUuid = isUuid(id);
        let pageId = id;

        if (!idIsUuid) {
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

  // ----------------------------------------------------------
  // sm_generate_schema
  // ----------------------------------------------------------
  server.registerTool(
    'sm_generate_schema',
    {
      title: 'Generate JSON-LD Schema',
      description: `Generate a JSON-LD Product schema (schema.org) for a document and optionally store it in sm_schema_org.

Fetches the document (name, description, subtitle, thumbnail_url, slug, category_id), resolves the category name, and builds a compliant Product JSON-LD.

Args:
  - collection: Collection name (e.g. "machines")
  - id: Document UUID or slug
  - locale: Locale (default "fr")
  - dry_run: If true (default), only returns the JSON-LD without saving

Returns:
  - The generated JSON-LD object
  - saved: boolean indicating if it was persisted`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
        locale: z.string().default('fr').describe('Locale'),
        dry_run: z.boolean().default(true).describe('If true, do not save to sm_schema_org'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, locale, dry_run }) => {
      return withAudit('sm_generate_schema', 'create', context.getActiveTargetName(), {
        collection,
        document_slug: id,
        params: { locale, dry_run },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // 1. Fetch the document
        const idIsUuid = isUuid(id);
        let query = client.from(config.table).select('*');
        if (idIsUuid) {
          query = query.eq('id', id);
        } else {
          query = query.eq(config.slug_field, id);
        }

        const { data: doc, error: docErr } = await query.single();
        if (docErr || !doc) throw new Error(`Document "${id}" not found in ${collection}.`);

        const machine = doc as Record<string, unknown>;
        const machineId = machine.id as string;

        // Resolve localized fields via shared helper
        const i18nStrategy = contract.i18n?.strategy || 'column';
        const defaultLocale = contract.i18n?.default_locale || 'fr';
        const isDefault = locale === defaultLocale;

        const name = getLocalized(machine, 'name', locale, contract) || getLocalized(machine, 'title', locale, contract) || (machine[config.display_field || 'name'] as string) || '';
        const description = getLocalized(machine, 'description', locale, contract) || getLocalized(machine, 'subtitle', locale, contract) || '';
        const thumbnailUrl = (machine.thumbnail_url || machine.image_url || machine.og_image || '') as string;
        const machineSlug = (machine[config.slug_field] || machine.slug || '') as string;

        // Resolve slug for locale if suffix i18n
        const localizedSlug = (i18nStrategy === 'suffix' && !isDefault
          ? (machine[`${config.slug_field}_${locale}`] as string) || machineSlug
          : machineSlug);

        // 2. Fetch category name + slug
        const categoryId = machine.category_id as string | null;
        let categoryName = '';
        let categorySlug = '';

        if (categoryId) {
          const { data: cat } = await client
            .from('categories')
            .select('*')
            .eq('id', categoryId)
            .single();

          if (cat) {
            const catRecord = cat as Record<string, unknown>;
            categoryName = (catRecord.name || catRecord.title || '') as string;
            categorySlug = (catRecord.slug || catRecord.url_slug || '') as string;

            // Try localized category name/slug
            if (i18nStrategy === 'suffix' && !isDefault) {
              categoryName = (catRecord[`name_${locale}`] as string) || categoryName;
              categorySlug = (catRecord[`slug_${locale}`] as string) || categorySlug;
            }
          }
        }

        // 3. Build JSON-LD Product
        const siteUrl = contract.site.url.replace(/\/$/, '');
        const machineUrl = `${siteUrl}/${locale}/machines/${categorySlug}/${localizedSlug}`;

        const jsonLd: Record<string, unknown> = {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name,
          description,
          image: thumbnailUrl || undefined,
          brand: {
            '@type': 'Brand',
            name: 'JAC',
          },
          manufacturer: {
            '@type': 'Organization',
            name: 'JAC Machines',
          },
          category: categoryName || undefined,
          url: machineUrl,
        };

        // Remove undefined values
        for (const key of Object.keys(jsonLd)) {
          if (jsonLd[key] === undefined || jsonLd[key] === '') {
            delete jsonLd[key];
          }
        }

        // 4. Save if not dry_run
        let saved = false;
        if (!dry_run) {
          // Upsert: check if a Product schema already exists for this page
          const { data: existing } = await client
            .from('sm_schema_org')
            .select('id')
            .eq('page_type', collection)
            .eq('page_id', machineId)
            .eq('locale', locale)
            .eq('schema_type', 'Product')
            .single();

          if (existing) {
            const { error: updateErr } = await client
              .from('sm_schema_org')
              .update({ data: jsonLd, validated: false })
              .eq('id', (existing as Record<string, unknown>).id);
            if (updateErr) throw new Error(`Failed to update schema: ${updateErr.message}`);
          } else {
            const { error: insertErr } = await client
              .from('sm_schema_org')
              .insert({
                page_type: collection,
                page_id: machineId,
                locale,
                schema_type: 'Product',
                data: jsonLd,
                validated: false,
              });
            if (insertErr) throw new Error(`Failed to insert schema: ${insertErr.message}`);
          }
          saved = true;
        }

        const output = {
          collection,
          document_id: machineId,
          slug: machineSlug,
          locale,
          json_ld: jsonLd,
          saved,
          dry_run,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_suggest_internal_links
  // ----------------------------------------------------------
  server.registerTool(
    'sm_suggest_internal_links',
    {
      title: 'Suggest Internal Links',
      description: `Suggest internal links between documents of the same category for SEO internal linking (maillage interne).

Groups documents by category and suggests links from each document to others in the same category with a relevance_score.

Args:
  - collection: Collection name (default "machines")
  - limit: Max documents to process (default 50)
  - dry_run: If true (default), only returns suggestions without saving

Returns:
  - total_suggestions: number of link suggestions
  - groups: suggestions grouped by source machine
  - batch_id: UUID of the batch (if saved)`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max documents to process'),
        dry_run: z.boolean().default(true).describe('If true, do not save to sm_internal_links'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, limit, dry_run }) => {
      return withAudit('sm_suggest_internal_links', 'create', context.getActiveTargetName(), {
        collection,
        params: { limit, dry_run },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // 1. Fetch all documents with their category
        const selectFields = `id, ${config.slug_field !== 'id' ? config.slug_field + ', ' : ''}${config.display_field ? config.display_field + ', ' : ''}category_id`;

        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select(selectFields)
          .order('created_at', { ascending: false })
          .limit(limit);

        if (docsErr) throw new Error(`Failed to fetch documents: ${docsErr.message}`);
        if (!docs || docs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, total_suggestions: 0, message: 'No documents found.' }, null, 2) }],
          };
        }

        // 2. Fetch all categories (cached, with parent_id fallback)
        const categoryMap = await fetchCategories(client);

        // 3. Group documents by category_id
        const byCategory = new Map<string, Record<string, unknown>[]>();
        for (const doc of docs as unknown as Record<string, unknown>[]) {
          const catId = doc.category_id as string | null;
          if (!catId) continue;
          if (!byCategory.has(catId)) byCategory.set(catId, []);
          byCategory.get(catId)!.push(doc);
        }

        // Helper: check if two categories share a parent
        function shareParent(catA: string, catB: string): boolean {
          const a = categoryMap.get(catA);
          const b = categoryMap.get(catB);
          if (!a || !b) return false;
          if (a.parent_id && b.parent_id && a.parent_id === b.parent_id) return true;
          if (a.parent_id === catB || b.parent_id === catA) return true;
          return false;
        }

        // 4. Generate suggestions
        const suggestions: {
          source_id: string;
          source_slug: string;
          source_name: string;
          target_id: string;
          target_slug: string;
          target_name: string;
          anchor_text: string;
          relevance_score: number;
          category: string;
        }[] = [];

        const batchId = crypto.randomUUID();

        for (const doc of docs as unknown as Record<string, unknown>[]) {
          const docId = doc.id as string;
          const docCatId = doc.category_id as string | null;
          if (!docCatId) continue;

          const docSlug = (config.slug_field !== 'id' ? doc[config.slug_field] : doc.id) as string;
          const docName = (config.display_field ? doc[config.display_field] : docSlug) as string;

          // Same category links
          const sameCatDocs = byCategory.get(docCatId) || [];
          for (const target of sameCatDocs) {
            if (target.id === docId) continue;
            const targetSlug = (config.slug_field !== 'id' ? target[config.slug_field] : target.id) as string;
            const targetName = (config.display_field ? target[config.display_field] : targetSlug) as string;
            const catRecord = categoryMap.get(docCatId);
            suggestions.push({
              source_id: docId,
              source_slug: docSlug,
              source_name: docName,
              target_id: target.id as string,
              target_slug: targetSlug,
              target_name: targetName,
              anchor_text: targetName,
              relevance_score: 0.8,
              category: (catRecord?.name as string) || docCatId,
            });
          }

          // Sibling category links (parent_id in common)
          for (const [otherCatId, otherDocs] of byCategory.entries()) {
            if (otherCatId === docCatId) continue;
            if (!shareParent(docCatId, otherCatId)) continue;

            for (const target of otherDocs) {
              const targetSlug = (config.slug_field !== 'id' ? target[config.slug_field] : target.id) as string;
              const targetName = (config.display_field ? target[config.display_field] : targetSlug) as string;
              const catRecord = categoryMap.get(otherCatId);
              suggestions.push({
                source_id: docId,
                source_slug: docSlug,
                source_name: docName,
                target_id: target.id as string,
                target_slug: targetSlug,
                target_name: targetName,
                anchor_text: targetName,
                relevance_score: 0.5,
                category: (catRecord?.name as string) || otherCatId,
              });
            }
          }
        }

        // 5. Save if not dry_run
        let saved = false;
        if (!dry_run && suggestions.length > 0) {
          const rows = suggestions.map(s => ({
            source_type: collection,
            source_id: s.source_id,
            target_type: collection,
            target_id: s.target_id,
            anchor_text: s.anchor_text,
            relevance_score: s.relevance_score,
            auto_generated: true,
            approved: null,
            batch_id: batchId,
          }));

          // Insert in batches of 100
          for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            const { error: insertErr } = await client
              .from('sm_internal_links')
              .insert(batch);
            if (insertErr) throw new Error(`Failed to insert links: ${insertErr.message}`);
          }
          saved = true;
        }

        // 6. Group output by source
        const grouped: Record<string, {
          source_slug: string;
          source_name: string;
          links: { target_slug: string; target_name: string; anchor_text: string; relevance_score: number; category: string }[];
        }> = {};

        for (const s of suggestions) {
          if (!grouped[s.source_id]) {
            grouped[s.source_id] = {
              source_slug: s.source_slug,
              source_name: s.source_name,
              links: [],
            };
          }
          grouped[s.source_id].links.push({
            target_slug: s.target_slug,
            target_name: s.target_name,
            anchor_text: s.anchor_text,
            relevance_score: s.relevance_score,
            category: s.category,
          });
        }

        const output = {
          collection,
          total_documents: docs.length,
          total_suggestions: suggestions.length,
          categories_found: byCategory.size,
          groups: Object.values(grouped),
          batch_id: !dry_run ? batchId : undefined,
          saved,
          dry_run,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_auto_fix_seo
  // ----------------------------------------------------------
  server.registerTool(
    'sm_auto_fix_seo',
    {
      title: 'Auto-Fix SEO',
      description: `Audit and auto-fix all SEO for a collection in one call. Generates missing meta titles, descriptions, focus keywords, canonicals, and JSON-LD schemas.

Args:
  - collection: Collection name (default "machines")
  - locale: Locale (default "fr")
  - limit: Max documents (default 50)
  - dry_run: If true (default), shows the plan without applying
  - confirm: If true, applies all corrections

Returns:
  - total_documents, documents_fixed, actions by type, score before/after avg`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        locale: z.string().default('fr').describe('Locale'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max documents'),
        dry_run: z.boolean().default(true).describe('Show plan without applying'),
        confirm: z.boolean().default(false).describe('Apply all corrections'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ collection, locale, limit, dry_run, confirm }) => {
      if (confirm) {
        const governance = loadGovernanceConfig();
        enforceGovernance('sm_auto_fix_seo', governance);
      }

      return withAudit('sm_auto_fix_seo', confirm ? 'update' : 'audit', context.getActiveTargetName(), {
        collection,
        params: { locale, limit, dry_run, confirm },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const i18nStrategy = contract.i18n?.strategy || 'column';
        const defaultLocale = contract.i18n?.default_locale || 'fr';
        const isDefault = locale === defaultLocale;
        const siteUrl = contract.site.url.replace(/\/$/, '');

        // 1. Fetch documents
        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (docsErr) throw new Error(`Failed to fetch documents: ${docsErr.message}`);
        if (!docs || docs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, locale, total_documents: 0, message: 'No documents found.' }, null, 2) }],
          };
        }

        const docRecords = docs as unknown as Record<string, unknown>[];
        const docIds = docRecords.map(d => d.id as string);

        // 2. Fetch existing SEO meta
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

        // 3. Fetch existing schemas
        const { data: existingSchemas } = await client
          .from('sm_schema_org')
          .select('page_id, schema_type')
          .eq('page_type', collection)
          .in('page_id', docIds);

        const schemaSet = new Set<string>();
        for (const row of (existingSchemas || []) as Record<string, unknown>[]) {
          schemaSet.add(`${row.page_id}:${row.schema_type}`);
        }

        // 4. Fetch categories (cached)
        const categoryMap = await fetchCategories(client);

        // 5. Build fix plan for each document
        const actions: {
          document_id: string;
          slug: string;
          name: string;
          fixes: { field: string; action: string; value: string }[];
          score_before: number;
          score_after: number;
        }[] = [];

        const actionCounts: Record<string, number> = {};
        const scoresBefore: number[] = [];
        const scoresAfter: number[] = [];

        // Bulk data for upserts
        const seoUpserts: Record<string, unknown>[] = [];
        const schemaInserts: Record<string, unknown>[] = [];

        for (const machine of docRecords) {
          const docId = machine.id as string;
          const existing = seoByPageId.get(docId);
          const machineSlug = (machine[config.slug_field] || machine.slug || '') as string;
          const machineName = getLocalized(machine, 'name', locale, contract) || getLocalized(machine, 'title', locale, contract) ||
            (config.display_field ? machine[config.display_field] as string : machineSlug) || '';
          const machineSubtitle = getLocalized(machine, 'subtitle', locale, contract) || '';
          const machineDesc = getLocalized(machine, 'description', locale, contract) || '';
          const categoryId = machine.category_id as string | null;
          const cat = categoryId ? categoryMap.get(categoryId) : null;
          const catName = cat ? (cat.name as string) : '';
          const catSlug = cat ? ((i18nStrategy === 'suffix' && !isDefault
            ? (cat[`slug_${locale}`] as string) || (cat.slug as string)
            : (cat.slug as string)) || '') : '';
          const localizedSlug = (i18nStrategy === 'suffix' && !isDefault
            ? (machine[`${config.slug_field}_${locale}`] as string) || machineSlug
            : machineSlug);

          const fixes: { field: string; action: string; value: string }[] = [];

          // Current SEO values
          let metaTitle = (existing?.meta_title as string | null) || null;
          let metaDesc = (existing?.meta_description as string | null) || null;
          let focusKeyword = (existing?.focus_keyword as string | null) || null;
          let canonical = (existing?.canonical as string | null) || null;

          // Score before
          const { score: scoreBefore } = computeSeoScore({ meta_title: metaTitle, meta_description: metaDesc, focus_keyword: focusKeyword });
          scoresBefore.push(scoreBefore);

          // a. Meta title missing
          if (!metaTitle?.trim()) {
            const suffix = machineSubtitle || catName;
            let generated = suffix ? `${machineName} | ${suffix} | JAC` : `${machineName} | JAC`;
            if (generated.length > 58) {
              generated = `${machineName} | JAC`;
            }
            if (generated.length > 58) {
              generated = generated.substring(0, 55) + '...';
            }
            metaTitle = generated;
            fixes.push({ field: 'meta_title', action: 'generated', value: generated });
            actionCounts['meta_title_generated'] = (actionCounts['meta_title_generated'] || 0) + 1;
          }

          // b. Meta description missing
          if (!metaDesc?.trim()) {
            let generated = machineDesc.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            if (generated.length > 155) {
              generated = generated.substring(0, 152) + '...';
            } else if (generated.length < 130 && machineSubtitle) {
              generated = `${machineSubtitle}. ${generated}`;
              if (generated.length > 155) {
                generated = generated.substring(0, 152) + '...';
              }
            }
            if (generated.length < 10) {
              generated = `${machineName} — ${catName || collection}. Découvrez cette machine professionnelle JAC.`;
            }
            metaDesc = generated;
            fixes.push({ field: 'meta_description', action: 'generated', value: generated });
            actionCounts['meta_description_generated'] = (actionCounts['meta_description_generated'] || 0) + 1;
          }

          // c. Focus keyword missing
          if (!focusKeyword?.trim()) {
            focusKeyword = machineName;
            fixes.push({ field: 'focus_keyword', action: 'generated', value: machineName });
            actionCounts['focus_keyword_generated'] = (actionCounts['focus_keyword_generated'] || 0) + 1;
          }

          // d. Canonical missing
          if (!canonical?.trim()) {
            const generatedUrl = `${siteUrl}/${locale}/machines/${catSlug}/${localizedSlug}`;
            canonical = generatedUrl;
            fixes.push({ field: 'canonical', action: 'generated', value: generatedUrl });
            actionCounts['canonical_generated'] = (actionCounts['canonical_generated'] || 0) + 1;
          }

          // e. Schema JSON-LD missing
          const hasSchema = schemaSet.has(`${docId}:Product`);
          if (!hasSchema) {
            const thumbnailUrl = (machine.thumbnail_url || machine.image_url || '') as string;
            const jsonLd = {
              '@context': 'https://schema.org',
              '@type': 'Product',
              name: machineName,
              description: metaDesc,
              ...(thumbnailUrl ? { image: thumbnailUrl } : {}),
              brand: { '@type': 'Brand', name: 'JAC' },
              manufacturer: { '@type': 'Organization', name: 'JAC Machines' },
              ...(catName ? { category: catName } : {}),
              url: canonical,
            };
            fixes.push({ field: 'schema_product', action: 'generated', value: `JSON-LD Product for ${machineName}` });
            actionCounts['schema_generated'] = (actionCounts['schema_generated'] || 0) + 1;

            if (confirm && !dry_run) {
              schemaInserts.push({
                page_type: collection,
                page_id: docId,
                locale,
                schema_type: 'Product',
                data: jsonLd,
                validated: false,
              });
            }
          }

          // Score after
          const { score: scoreAfter } = computeSeoScore({ meta_title: metaTitle, meta_description: metaDesc, focus_keyword: focusKeyword });
          scoresAfter.push(scoreAfter);

          if (fixes.length > 0) {
            actions.push({
              document_id: docId,
              slug: machineSlug,
              name: machineName,
              fixes,
              score_before: scoreBefore,
              score_after: scoreAfter,
            });

            // Prepare upsert data
            if (confirm && !dry_run) {
              const scoreDetails: Record<string, number> = {};
              const { checks } = computeSeoScore({ meta_title: metaTitle, meta_description: metaDesc, focus_keyword: focusKeyword });
              for (const check of checks) {
                scoreDetails[check.name] = check.penalty;
              }

              seoUpserts.push({
                docId,
                existing,
                data: {
                  meta_title: metaTitle,
                  meta_description: metaDesc,
                  focus_keyword: focusKeyword,
                  canonical,
                  seo_score: scoreAfter,
                  score_details: scoreDetails,
                  last_audit: new Date().toISOString(),
                },
              });
            }
          }
        }

        // 6. Apply corrections if confirm=true and dry_run=false
        let applied = false;
        if (confirm && !dry_run && (seoUpserts.length > 0 || schemaInserts.length > 0)) {
          // Upsert SEO meta
          for (const item of seoUpserts as { docId: string; existing: Record<string, unknown> | undefined; data: Record<string, unknown> }[]) {
            if (item.existing) {
              await client
                .from('sm_seo_meta')
                .update(item.data)
                .eq('id', item.existing.id);
            } else {
              await client
                .from('sm_seo_meta')
                .insert({
                  page_type: collection,
                  page_id: item.docId,
                  locale,
                  og_title: null,
                  og_description: null,
                  og_image: null,
                  noindex: false,
                  nofollow: false,
                  ...item.data,
                });
            }
          }

          // Insert schemas in batches
          if (schemaInserts.length > 0) {
            for (let i = 0; i < schemaInserts.length; i += 50) {
              const batch = schemaInserts.slice(i, i + 50);
              await client.from('sm_schema_org').insert(batch);
            }
          }

          applied = true;
        }

        // 7. Build output
        const avgBefore = scoresBefore.length > 0 ? Math.round(scoresBefore.reduce((a, b) => a + b, 0) / scoresBefore.length) : 0;
        const avgAfter = scoresAfter.length > 0 ? Math.round(scoresAfter.reduce((a, b) => a + b, 0) / scoresAfter.length) : 0;

        const output = {
          collection,
          locale,
          total_documents: docRecords.length,
          documents_fixed: actions.length,
          documents_already_ok: docRecords.length - actions.length,
          actions_taken: actionCounts,
          score_before_avg: avgBefore,
          score_after_avg: avgAfter,
          score_improvement: avgAfter - avgBefore,
          applied,
          dry_run,
          confirm,
          plan: actions.map(a => ({
            slug: a.slug,
            name: a.name,
            score: `${a.score_before} → ${a.score_after}`,
            fixes: a.fixes.map(f => `${f.field}: ${f.action}`),
          })),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_score_global
  // ----------------------------------------------------------
  server.registerTool(
    'sm_score_global',
    {
      title: 'Global Site Score',
      description: `Calculate a single 0-100 score for the entire site, aggregating all SEO dimensions.

Dimensions:
  - SEO Score (40%): average seo_score from sm_seo_meta
  - Schema Coverage (20%): % of documents with JSON-LD in sm_schema_org
  - Internal Links Health (15%): % of pages with approved internal links
  - Orphan Pages Penalty (10%): % of pages with no inbound links
  - Meta Completeness (15%): % of documents with both meta_title and meta_description

Args:
  - locale: Locale to evaluate (default "fr")

Returns:
  - Global score, per-dimension breakdown, top 5 pages to improve, trend vs last audit`,
      inputSchema: {
        locale: z.string().default('fr').describe('Locale to evaluate'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ locale }) => {
      return withAudit('sm_score_global', 'audit', context.getActiveTargetName(), {
        params: { locale },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const client = context.getClient();

        // Count total documents across all collections
        let totalDocuments = 0;
        const collectionCounts: Record<string, number> = {};
        for (const [name, config] of Object.entries(contract.collections)) {
          const { count } = await client
            .from(config.table)
            .select('*', { count: 'exact', head: true });
          const c = count || 0;
          collectionCounts[name] = c;
          totalDocuments += c;
        }

        if (totalDocuments === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ score: 0, message: 'No documents found in any collection.' }, null, 2) }],
          };
        }

        // 1. SEO Score (40%) — average seo_score
        const { data: seoData } = await client
          .from('sm_seo_meta')
          .select('page_id, page_type, seo_score, meta_title, meta_description')
          .eq('locale', locale);

        const seoRecords = (seoData || []) as Record<string, unknown>[];
        const seoScores = seoRecords.map(r => r.seo_score as number);
        const seoAvg = seoScores.length > 0
          ? seoScores.reduce((a, b) => a + b, 0) / seoScores.length
          : 0;

        // 2. Schema Coverage (20%) — % of documents with at least one schema
        const { data: schemaData } = await client
          .from('sm_schema_org')
          .select('page_id');

        const uniqueSchemaPages = new Set((schemaData || []).map((r: Record<string, unknown>) => r.page_id));
        const schemaPct = totalDocuments > 0
          ? (uniqueSchemaPages.size / totalDocuments) * 100
          : 0;

        // 3. Internal Links Health (15%) — % of pages with approved outbound links
        const { data: linksData } = await client
          .from('sm_internal_links')
          .select('source_id')
          .eq('approved', true);

        const uniqueLinkedPages = new Set((linksData || []).map((r: Record<string, unknown>) => r.source_id));
        const linksPct = totalDocuments > 0
          ? (uniqueLinkedPages.size / totalDocuments) * 100
          : 0;

        // 4. Orphan Pages Penalty (10%) — % of pages with no inbound links
        // Try the view first, fallback to manual check
        let orphanPct = 0;
        const { data: inboundData } = await client
          .from('sm_internal_links')
          .select('target_id')
          .eq('approved', true);

        const pagesWithInbound = new Set((inboundData || []).map((r: Record<string, unknown>) => r.target_id));
        // Documents without inbound = orphans
        const pagesWithSeo = new Set(seoRecords.map(r => r.page_id as string));
        const allTrackedPages = new Set([...pagesWithSeo, ...uniqueSchemaPages, ...uniqueLinkedPages]);
        const orphanCount = [...allTrackedPages].filter(p => !pagesWithInbound.has(p)).length;
        orphanPct = allTrackedPages.size > 0
          ? (orphanCount / allTrackedPages.size) * 100
          : 100;

        // 5. Meta Completeness (15%) — % with both meta_title AND meta_description
        const completeMeta = seoRecords.filter(r =>
          (r.meta_title as string | null)?.trim() && (r.meta_description as string | null)?.trim()
        ).length;
        const metaPct = totalDocuments > 0
          ? (completeMeta / totalDocuments) * 100
          : 0;

        // Calculate global score
        const globalScore = Math.round(
          (seoAvg * 0.4) +
          (schemaPct * 0.2) +
          (linksPct * 0.15) +
          ((100 - orphanPct) * 0.1) +
          (metaPct * 0.15)
        );

        // Top 5 pages to improve (lowest SEO scores)
        const sortedByScore = [...seoRecords]
          .sort((a, b) => (a.seo_score as number) - (b.seo_score as number))
          .slice(0, 5);

        // Trend vs last audit — check sm_seo_history for latest entry
        let trend: { previous_avg: number; delta: number } | null = null;
        try {
          const { data: historyData } = await client
            .from('sm_seo_history')
            .select('avg_score, audited_at')
            .eq('locale', locale)
            .order('audited_at', { ascending: false })
            .limit(1);

          if (historyData && historyData.length > 0) {
            const prev = (historyData[0] as Record<string, unknown>).avg_score as number;
            trend = {
              previous_avg: prev,
              delta: Math.round(seoAvg - prev),
            };
          }
        } catch {
          // sm_seo_history might not exist
        }

        const output = {
          score: globalScore,
          locale,
          total_documents: totalDocuments,
          dimensions: {
            seo_score: {
              weight: '40%',
              value: Math.round(seoAvg),
              documents_with_meta: seoRecords.length,
              contribution: Math.round(seoAvg * 0.4),
            },
            schema_coverage: {
              weight: '20%',
              value: Math.round(schemaPct),
              documents_with_schema: uniqueSchemaPages.size,
              contribution: Math.round(schemaPct * 0.2),
            },
            internal_links_health: {
              weight: '15%',
              value: Math.round(linksPct),
              pages_with_links: uniqueLinkedPages.size,
              contribution: Math.round(linksPct * 0.15),
            },
            orphan_pages: {
              weight: '10%',
              value: Math.round(orphanPct),
              orphan_count: orphanCount,
              tracked_pages: allTrackedPages.size,
              contribution: Math.round((100 - orphanPct) * 0.1),
            },
            meta_completeness: {
              weight: '15%',
              value: Math.round(metaPct),
              complete_count: completeMeta,
              contribution: Math.round(metaPct * 0.15),
            },
          },
          top_5_to_improve: sortedByScore.map(r => ({
            page_id: r.page_id,
            page_type: r.page_type,
            seo_score: r.seo_score,
            has_title: !!(r.meta_title as string | null)?.trim(),
            has_description: !!(r.meta_description as string | null)?.trim(),
          })),
          trend,
          collections: collectionCounts,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_check_rendering
  // ----------------------------------------------------------
  server.registerTool(
    'sm_check_rendering',
    {
      title: 'Check SEO Rendering',
      description: `Compare the HTML rendered by the server vs the SEO data in sm_seo_meta. Detects whether meta tags, JSON-LD schemas, and canonical are properly injected via SSR/Edge Function.

Args:
  - url: Full URL to check (e.g. "https://jac-machines.media/fr/machines/trancheuses-a-pains-pour-professionnels/duro")

Returns:
  - title, description, og tags, canonical, JSON-LD found in HTML
  - Comparison with sm_seo_meta values
  - Verdict: OK or PROBLEM with details`,
      inputSchema: {
        url: z.string().url().describe('Full URL to check'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      return withAudit('sm_check_rendering', 'audit', context.getActiveTargetName(), {
        params: { url },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const client = context.getClient();

        // 1. Fetch the HTML
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SiteManagerBot/1.0; +https://adsim.be)',
            'Accept': 'text/html',
          },
          redirect: 'follow',
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
        }

        const html = await response.text();

        // 2. Parse meta tags from HTML using regex (no DOM parser needed)
        const extractMeta = (name: string, attr = 'name'): string | null => {
          const regex = new RegExp(`<meta\\s+${attr}=["']${name}["']\\s+content=["']([^"']*)["']`, 'i');
          const match = html.match(regex);
          if (match) return match[1];
          // Try reversed attribute order
          const regex2 = new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attr}=["']${name}["']`, 'i');
          const match2 = html.match(regex2);
          return match2 ? match2[1] : null;
        };

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const htmlTitle = titleMatch ? titleMatch[1].trim() : null;
        const htmlDescription = extractMeta('description');
        const htmlOgTitle = extractMeta('og:title', 'property');
        const htmlOgDescription = extractMeta('og:description', 'property');
        const htmlOgImage = extractMeta('og:image', 'property');
        const htmlRobots = extractMeta('robots');

        // Canonical
        const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']*)["']/i);
        const htmlCanonical = canonicalMatch ? canonicalMatch[1] : null;

        // JSON-LD scripts
        const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        const jsonLdBlocks: { type: string; data: unknown }[] = [];
        let jsonLdExec;
        while ((jsonLdExec = jsonLdRegex.exec(html)) !== null) {
          try {
            const parsed = JSON.parse(jsonLdExec[1]);
            jsonLdBlocks.push({
              type: parsed['@type'] || 'unknown',
              data: parsed,
            });
          } catch {
            jsonLdBlocks.push({ type: 'parse_error', data: jsonLdExec[1].substring(0, 200) });
          }
        }

        // Hreflang tags
        const hreflangRegex = /<link\s+rel=["']alternate["']\s+hreflang=["']([^"']*)["']\s+href=["']([^"']*)["']/gi;
        const hreflangs: { lang: string; href: string }[] = [];
        let hlExec;
        while ((hlExec = hreflangRegex.exec(html)) !== null) {
          hreflangs.push({ lang: hlExec[1], href: hlExec[2] });
        }

        // 3. Try to match the URL to a document in sm_seo_meta
        // Extract slug from URL: last path segment
        const urlParts = new URL(url).pathname.split('/').filter(Boolean);
        const machineSlug = urlParts[urlParts.length - 1] || '';
        const localeFromUrl = urlParts[0] || 'fr';

        let dbTitle: string | null = null;
        let dbDescription: string | null = null;
        let dbCanonical: string | null = null;
        let dbOgTitle: string | null = null;
        let dbNoindex = false;
        let dbFound = false;

        // Find the document by slug across collections
        for (const [collName, collConfig] of Object.entries(contract.collections)) {
          const { data: doc } = await client
            .from(collConfig.table)
            .select('id')
            .eq(collConfig.slug_field, machineSlug)
            .single();

          if (doc) {
            const docId = (doc as Record<string, unknown>).id as string;
            const { data: seo } = await client
              .from('sm_seo_meta')
              .select('*')
              .eq('page_type', collName)
              .eq('page_id', docId)
              .eq('locale', localeFromUrl)
              .single();

            if (seo) {
              const s = seo as Record<string, unknown>;
              dbTitle = s.meta_title as string | null;
              dbDescription = s.meta_description as string | null;
              dbCanonical = s.canonical as string | null;
              dbOgTitle = s.og_title as string | null;
              dbNoindex = s.noindex as boolean;
              dbFound = true;
            }
            break;
          }
        }

        // 4. Build comparison
        const titleMatched = dbFound && !!htmlTitle && !!dbTitle && htmlTitle.includes(dbTitle);
        const descMatched = dbFound && !!htmlDescription && !!dbDescription && htmlDescription === dbDescription;

        const gaps: string[] = [];
        if (!htmlTitle) gaps.push('No <title> tag found in HTML');
        if (dbFound && dbTitle && htmlTitle && !titleMatched) gaps.push(`Title mismatch: HTML="${htmlTitle}" vs DB="${dbTitle}"`);
        if (!htmlDescription) gaps.push('No meta description in HTML');
        if (dbFound && dbDescription && htmlDescription && !descMatched) gaps.push(`Description mismatch`);
        if (!htmlCanonical) gaps.push('No canonical tag in HTML');
        if (!htmlOgTitle && !htmlOgDescription) gaps.push('No Open Graph tags found');
        if (jsonLdBlocks.length === 0) gaps.push('No JSON-LD structured data found');
        if (dbFound && dbNoindex && htmlRobots !== 'noindex') gaps.push('DB says noindex but HTML does not enforce it');
        if (!dbFound) gaps.push(`No SEO meta found in DB for slug "${machineSlug}" locale "${localeFromUrl}"`);

        const verdict = gaps.length === 0
          ? 'OK — les meta sont correctement injectées'
          : `PROBLÈME — ${gaps.length} gap(s) entre DB et HTML rendu`;

        const output = {
          url,
          http_status: response.status,
          html_analysis: {
            title_in_html: htmlTitle,
            description_in_html: htmlDescription,
            og_title: htmlOgTitle,
            og_description: htmlOgDescription,
            og_image: htmlOgImage,
            canonical_in_html: htmlCanonical,
            robots_meta: htmlRobots || 'not set (defaults to index,follow)',
            jsonld_blocks: jsonLdBlocks.map(b => ({ type: b.type })),
            jsonld_count: jsonLdBlocks.length,
            hreflangs,
          },
          db_comparison: {
            db_found: dbFound,
            title_in_db: dbTitle,
            title_match: titleMatched,
            description_in_db: dbDescription,
            description_match: descMatched,
            canonical_in_db: dbCanonical,
            og_title_in_db: dbOgTitle,
            noindex_in_db: dbNoindex,
          },
          gaps,
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
  // sm_generate_canonical
  // ----------------------------------------------------------
  server.registerTool(
    'sm_generate_canonical',
    {
      title: 'Generate Canonical URLs',
      description: `Generate and persist canonical URLs and hreflang alternates for all documents in a collection.

Builds canonical URLs using the pattern: {base_url}/{locale}/machines/{category_slug}/{machine_slug}
If i18n is enabled, also generates hreflang alternate URLs for each locale.

Args:
  - collection: Collection name (default "machines")
  - locale: Primary locale (default "fr")
  - base_url: Site base URL (default from Content Contract)
  - limit: Max documents (default 50)
  - dry_run: If true (default), shows plan without saving

Returns:
  - documents_processed, canonicals_generated, hreflang alternates`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        locale: z.string().default('fr').describe('Primary locale'),
        base_url: z.string().optional().describe('Base URL override (defaults to Content Contract site URL)'),
        limit: z.number().int().min(1).max(200).default(50).describe('Max documents'),
        dry_run: z.boolean().default(true).describe('If true, do not persist'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, locale, base_url, limit, dry_run }) => {
      if (!dry_run) {
        const governance = loadGovernanceConfig();
        enforceGovernance('sm_generate_canonical', governance);
      }

      return withAudit('sm_generate_canonical', dry_run ? 'audit' : 'update', context.getActiveTargetName(), {
        collection,
        params: { locale, base_url, limit, dry_run },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const siteUrl = (base_url || contract.site.url).replace(/\/$/, '');
        const i18nEnabled = contract.i18n?.enabled || false;
        const locales = contract.i18n?.locales || [locale];
        const i18nStrategy = contract.i18n?.strategy || 'column';
        const defaultLocale = contract.i18n?.default_locale || 'fr';

        // 1. Fetch documents
        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (docsErr) throw new Error(`Failed to fetch documents: ${docsErr.message}`);
        if (!docs || docs.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, total: 0, message: 'No documents found.' }, null, 2) }],
          };
        }

        // 2. Fetch categories
        let categoriesData: Record<string, unknown>[] = [];
        const { data: catData, error: catErr } = await client
          .from('categories')
          .select('*');
        if (!catErr && catData) {
          categoriesData = catData as Record<string, unknown>[];
        }
        const categoryMap = new Map<string, Record<string, unknown>>();
        for (const cat of categoriesData) {
          categoryMap.set(cat.id as string, cat);
        }

        // 3. Fetch existing SEO meta
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

        // 4. Generate canonicals and hreflangs
        const results: {
          slug: string;
          name: string;
          canonical: string;
          hreflangs: { locale: string; url: string }[];
          had_canonical: boolean;
        }[] = [];

        const docRecords = docs as unknown as Record<string, unknown>[];

        for (const machine of docRecords) {
          const docId = machine.id as string;
          const machineSlug = (machine[config.slug_field] || '') as string;
          const machineName = (config.display_field ? machine[config.display_field] : machineSlug) as string;
          const categoryId = machine.category_id as string | null;
          const cat = categoryId ? categoryMap.get(categoryId) : null;

          // Resolve category slug for a locale
          const getCatSlug = (loc: string): string => {
            if (!cat) return '';
            if (i18nStrategy === 'suffix' && loc !== defaultLocale) {
              return (cat[`slug_${loc}`] as string) || (cat.slug as string) || '';
            }
            return (cat.slug as string) || '';
          };

          // Resolve machine slug for a locale
          const getMachineSlug = (loc: string): string => {
            if (i18nStrategy === 'suffix' && loc !== defaultLocale) {
              return (machine[`${config.slug_field}_${loc}`] as string) || machineSlug;
            }
            return machineSlug;
          };

          const canonical = `${siteUrl}/${locale}/machines/${getCatSlug(locale)}/${getMachineSlug(locale)}`;

          // Build hreflang alternates
          const hreflangs: { locale: string; url: string }[] = [];
          if (i18nEnabled && locales.length > 1) {
            for (const loc of locales) {
              hreflangs.push({
                locale: loc,
                url: `${siteUrl}/${loc}/machines/${getCatSlug(loc)}/${getMachineSlug(loc)}`,
              });
            }
            // x-default points to default locale
            hreflangs.push({
              locale: 'x-default',
              url: `${siteUrl}/${defaultLocale}/machines/${getCatSlug(defaultLocale)}/${getMachineSlug(defaultLocale)}`,
            });
          }

          const existing = seoByPageId.get(docId);
          const hadCanonical = !!(existing?.canonical as string | null)?.trim();

          results.push({
            slug: machineSlug,
            name: machineName,
            canonical,
            hreflangs,
            had_canonical: hadCanonical,
          });

          // 5. Persist if not dry_run
          if (!dry_run) {
            const hreflangData = hreflangs.length > 0 ? hreflangs : undefined;

            if (existing) {
              await client
                .from('sm_seo_meta')
                .update({
                  canonical,
                  ...(hreflangData ? { hreflang: hreflangData } : {}),
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
                  canonical,
                  og_title: null,
                  og_description: null,
                  og_image: null,
                  noindex: false,
                  nofollow: false,
                  seo_score: 0,
                  score_details: {},
                  ...(hreflangData ? { hreflang: hreflangData } : {}),
                });
            }
          }
        }

        const newCanonicals = results.filter(r => !r.had_canonical).length;
        const totalHreflangs = results.reduce((acc, r) => acc + r.hreflangs.length, 0);

        const output = {
          collection,
          locale,
          base_url: siteUrl,
          documents_processed: results.length,
          canonicals_generated: newCanonicals,
          canonicals_updated: results.length - newCanonicals,
          hreflang_count: totalHreflangs,
          i18n_enabled: i18nEnabled,
          locales_covered: i18nEnabled ? locales : [locale],
          dry_run,
          documents: results.map(r => ({
            slug: r.slug,
            name: r.name,
            canonical: r.canonical,
            hreflangs: r.hreflangs.length > 0 ? r.hreflangs : undefined,
            was_missing: !r.had_canonical,
          })),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_find_orphan_pages
  // ----------------------------------------------------------
  server.registerTool(
    'sm_find_orphan_pages',
    {
      title: 'Find Orphan Pages',
      description: `Find pages that have no inbound internal links (orphan pages). Uses the sm_orphan_pages view which cross-references sm_seo_meta with sm_internal_links.

Args:
  - locale: Locale to check (default "fr")
  - limit: Max results (default 20)

Returns:
  - List of orphan pages with page_type, page_id, meta_title, seo_score
  - Total orphan count and percentage vs total pages`,
      inputSchema: {
        locale: z.string().default('fr').describe('Locale to check'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ locale, limit }) => {
      return withAudit('sm_find_orphan_pages', 'audit', context.getActiveTargetName(), {
        params: { locale, limit },
      }, async () => {
        const client = context.getClient();

        // Query the sm_orphan_pages view
        const { data: orphans, error: orphanErr } = await client
          .from('sm_orphan_pages')
          .select('page_type, page_id, locale, meta_title, seo_score')
          .eq('locale', locale)
          .order('seo_score', { ascending: true })
          .limit(limit);

        if (orphanErr) throw new Error(`Failed to query sm_orphan_pages: ${orphanErr.message}`);

        // Get total count of orphans for this locale
        const { count: orphanTotal } = await client
          .from('sm_orphan_pages')
          .select('*', { count: 'exact', head: true })
          .eq('locale', locale);

        // Get total pages in sm_seo_meta for this locale
        const { count: totalPages } = await client
          .from('sm_seo_meta')
          .select('*', { count: 'exact', head: true })
          .eq('locale', locale);

        const orphanCount = orphanTotal || 0;
        const totalCount = totalPages || 0;
        const orphanPct = totalCount > 0 ? Math.round((orphanCount / totalCount) * 100) : 0;

        const output = {
          locale,
          orphan_count: orphanCount,
          total_pages: totalCount,
          orphan_percentage: orphanPct,
          pages: ((orphans || []) as Record<string, unknown>[]).map(o => ({
            page_type: o.page_type,
            page_id: o.page_id,
            meta_title: o.meta_title || '(no title)',
            seo_score: o.seo_score,
          })),
          recommendation: orphanPct > 50
            ? 'Critical — more than half your pages are orphans. Run sm_suggest_internal_links to generate link suggestions.'
            : orphanPct > 20
              ? 'Warning — significant orphan pages. Consider adding internal links.'
              : 'Good — most pages have inbound links.',
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
