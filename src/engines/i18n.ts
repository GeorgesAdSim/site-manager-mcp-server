/**
 * i18n Engine — Translation coverage, missing translations, SEO locale sync
 *
 * Tools:
 *   sm_translation_coverage   — % of translatable fields filled per locale
 *   sm_missing_translations   — List documents with empty translatable fields for a locale
 *   sm_sync_seo_locales       — Copy SEO meta from source locale to target locales
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';
import { getLocalized } from '../shared/helpers.js';

// ============================================================
// Register i18n tools
// ============================================================

export function registerI18nTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_translation_coverage
  // ----------------------------------------------------------
  server.registerTool(
    'sm_translation_coverage',
    {
      title: 'Translation Coverage',
      description: `Check translation coverage for a collection. For each locale, reports % of translatable fields that have a non-empty value (via suffix columns like name_en, description_de).

Args:
  - collection: Collection name (default "machines")
  - locale: Specific locale to check (optional — if omitted, checks all detected locales)

Returns:
  - Per-locale: coverage %, fields translated vs total, top 5 least-translated documents`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        locale: z.string().optional().describe('Specific locale (omit for all)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, locale }) => {
      return withAudit('sm_translation_coverage', 'audit', context.getActiveTargetName(), {
        collection,
        params: { locale },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        if (contract.i18n?.strategy !== 'suffix') {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              message: 'i18n strategy is not "suffix". This tool only works with suffix-based translations (e.g. name_en, description_de).',
            }, null, 2) }],
          };
        }

        const client = context.getClient();
        const defaultLocale = contract.i18n.default_locale || 'fr';
        const allLocales = contract.i18n.locales || ['fr'];

        // Determine which locales to check
        const localesToCheck = locale ? [locale] : allLocales.filter(l => l !== defaultLocale);

        // Find translatable fields
        const translatableFields = Object.entries(config.fields)
          .filter(([, f]) => f.translatable)
          .map(([name]) => name);

        if (translatableFields.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              message: 'No translatable fields found in this collection.',
              translatable_fields: [],
            }, null, 2) }],
          };
        }

        // Fetch all documents
        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select('*')
          .order('created_at', { ascending: false });

        if (docsErr || !docs || docs.length === 0) {
          throw new Error('No documents found.');
        }

        const docRecords = docs as unknown as Record<string, unknown>[];
        const displayField = config.display_field || config.slug_field;

        // Analyze per locale
        const localeResults: {
          locale: string;
          total_fields: number;
          translated_fields: number;
          coverage_pct: number;
          documents_analyzed: number;
          least_translated: { name: string; slug: string; translated: number; total: number; pct: number }[];
        }[] = [];

        for (const loc of localesToCheck) {
          let totalFields = 0;
          let translatedFields = 0;

          const perDoc: { name: string; slug: string; translated: number; total: number; pct: number }[] = [];

          for (const doc of docRecords) {
            let docTranslated = 0;
            const docTotal = translatableFields.length;

            for (const field of translatableFields) {
              totalFields++;
              const suffixKey = `${field}_${loc}`;
              const val = doc[suffixKey];
              if (val != null && String(val).trim() !== '') {
                translatedFields++;
                docTranslated++;
              }
            }

            const docName = (doc[displayField] || doc[config.slug_field] || '') as string;
            const docSlug = (doc[config.slug_field] || '') as string;
            perDoc.push({
              name: docName,
              slug: docSlug,
              translated: docTranslated,
              total: docTotal,
              pct: docTotal > 0 ? Math.round((docTranslated / docTotal) * 100) : 0,
            });
          }

          // Sort by coverage ascending, take bottom 5
          perDoc.sort((a, b) => a.pct - b.pct);

          localeResults.push({
            locale: loc,
            total_fields: totalFields,
            translated_fields: translatedFields,
            coverage_pct: totalFields > 0 ? Math.round((translatedFields / totalFields) * 100) : 0,
            documents_analyzed: docRecords.length,
            least_translated: perDoc.slice(0, 5),
          });
        }

        const output = {
          collection,
          default_locale: defaultLocale,
          translatable_fields: translatableFields,
          locales: localeResults,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_missing_translations
  // ----------------------------------------------------------
  server.registerTool(
    'sm_missing_translations',
    {
      title: 'Missing Translations',
      description: `List documents where translatable fields are empty for a specific locale. Prioritized by the FR seo_score (higher score = higher translation priority).

Args:
  - collection: Collection name (default "machines")
  - locale: Target locale to check (required)
  - limit: Max documents to return (default 20)

Returns:
  - Documents with missing fields, sorted by priority (FR SEO score desc)`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        locale: z.string().describe('Target locale to check'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, locale, limit }) => {
      return withAudit('sm_missing_translations', 'audit', context.getActiveTargetName(), {
        collection,
        params: { locale, limit },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        if (contract.i18n?.strategy !== 'suffix') {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              message: 'i18n strategy is not "suffix".',
            }, null, 2) }],
          };
        }

        const client = context.getClient();
        const defaultLocale = contract.i18n.default_locale || 'fr';

        // Find translatable fields
        const translatableFields = Object.entries(config.fields)
          .filter(([, f]) => f.translatable)
          .map(([name]) => name);

        if (translatableFields.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ collection, locale, message: 'No translatable fields.' }, null, 2) }],
          };
        }

        // Fetch documents
        const { data: docs, error: docsErr } = await client
          .from(config.table)
          .select('*')
          .order('created_at', { ascending: false });

        if (docsErr || !docs || docs.length === 0) throw new Error('No documents found.');
        const docRecords = docs as unknown as Record<string, unknown>[];

        // Fetch FR SEO scores for prioritization
        const docIds = docRecords.map(d => d.id as string);
        const { data: seoData } = await client
          .from('sm_seo_meta')
          .select('page_id, seo_score')
          .eq('page_type', collection)
          .eq('locale', defaultLocale)
          .in('page_id', docIds);

        const scoreByPageId = new Map<string, number>();
        for (const row of (seoData || []) as Record<string, unknown>[]) {
          scoreByPageId.set(row.page_id as string, row.seo_score as number);
        }

        const displayField = config.display_field || config.slug_field;

        // Find docs with missing translations
        const missing: {
          document_id: string;
          name: string;
          slug: string;
          missing_fields: string[];
          translated_fields: string[];
          coverage_pct: number;
          fr_seo_score: number;
          priority: 'high' | 'medium' | 'low';
        }[] = [];

        for (const doc of docRecords) {
          const docId = doc.id as string;
          const missingFields: string[] = [];
          const translatedFields: string[] = [];

          for (const field of translatableFields) {
            const suffixKey = `${field}_${locale}`;
            const val = doc[suffixKey];
            if (val == null || String(val).trim() === '') {
              missingFields.push(field);
            } else {
              translatedFields.push(field);
            }
          }

          if (missingFields.length === 0) continue; // Fully translated

          const frScore = scoreByPageId.get(docId) || 0;
          const coverage = translatableFields.length > 0
            ? Math.round((translatedFields.length / translatableFields.length) * 100)
            : 0;

          missing.push({
            document_id: docId,
            name: getLocalized(doc, displayField, defaultLocale, contract) || (doc[displayField] as string) || '',
            slug: (doc[config.slug_field] || '') as string,
            missing_fields: missingFields,
            translated_fields: translatedFields,
            coverage_pct: coverage,
            fr_seo_score: frScore,
            priority: frScore >= 80 ? 'high' : frScore >= 50 ? 'medium' : 'low',
          });
        }

        // Sort by FR SEO score desc (high-value pages first)
        missing.sort((a, b) => b.fr_seo_score - a.fr_seo_score);
        const limited = missing.slice(0, limit);

        const output = {
          collection,
          locale,
          default_locale: defaultLocale,
          translatable_fields: translatableFields,
          total_documents: docRecords.length,
          documents_with_gaps: missing.length,
          documents_fully_translated: docRecords.length - missing.length,
          results: limited,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_sync_seo_locales
  // ----------------------------------------------------------
  server.registerTool(
    'sm_sync_seo_locales',
    {
      title: 'Sync SEO Locales',
      description: `Copy SEO meta from a source locale to target locales that don't have meta yet. Adapts canonical URLs by replacing the locale in the path.

Args:
  - collection: Collection name (default "machines")
  - source_locale: Source locale to copy from (default "fr")
  - target_locales: Array of target locales (default: all locales except source)
  - dry_run: If true (default), shows plan without applying

Returns:
  - Per-locale: number of meta copied, documents affected
  - Total meta created`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        source_locale: z.string().default('fr').describe('Source locale'),
        target_locales: z.array(z.string()).optional().describe('Target locales (default: all except source)'),
        dry_run: z.boolean().default(true).describe('Preview mode — no writes'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, source_locale, target_locales, dry_run }) => {
      return withAudit('sm_sync_seo_locales', dry_run ? 'audit' : 'create', context.getActiveTargetName(), {
        collection,
        params: { source_locale, target_locales, dry_run },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const allLocales = contract.i18n?.locales || ['fr'];
        const targets = target_locales && target_locales.length > 0
          ? target_locales
          : allLocales.filter(l => l !== source_locale);

        if (targets.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              source_locale,
              message: 'No target locales to sync to.',
            }, null, 2) }],
          };
        }

        // 1. Fetch source SEO meta
        const { data: sourceSeo } = await client
          .from('sm_seo_meta')
          .select('*')
          .eq('page_type', collection)
          .eq('locale', source_locale);

        const sourceRecords = (sourceSeo || []) as Record<string, unknown>[];

        if (sourceRecords.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              collection,
              source_locale,
              message: `No SEO meta found for locale "${source_locale}". Run sm_audit_seo first.`,
            }, null, 2) }],
          };
        }

        // 2. Fetch existing meta for all target locales
        const { data: existingTargets } = await client
          .from('sm_seo_meta')
          .select('page_id, locale')
          .eq('page_type', collection)
          .in('locale', targets);

        const existingSet = new Set<string>();
        for (const row of (existingTargets || []) as Record<string, unknown>[]) {
          existingSet.add(`${row.page_id}:${row.locale}`);
        }

        // 3. Plan sync
        const perLocale: Record<string, { count: number; page_ids: string[] }> = {};
        const inserts: Record<string, unknown>[] = [];

        for (const target of targets) {
          perLocale[target] = { count: 0, page_ids: [] };
        }

        for (const source of sourceRecords) {
          const pageId = source.page_id as string;
          const sourceCanonical = (source.canonical as string | null) || '';

          for (const target of targets) {
            const key = `${pageId}:${target}`;
            if (existingSet.has(key)) continue; // Already has meta for this locale

            // Adapt canonical URL: replace /{source_locale}/ with /{target}/
            let adaptedCanonical = sourceCanonical;
            if (sourceCanonical) {
              adaptedCanonical = sourceCanonical.replace(`/${source_locale}/`, `/${target}/`);
            }

            inserts.push({
              page_type: collection,
              page_id: pageId,
              locale: target,
              meta_title: source.meta_title,
              meta_description: source.meta_description,
              focus_keyword: source.focus_keyword,
              canonical: adaptedCanonical,
              og_title: source.og_title,
              og_description: source.og_description,
              og_image: source.og_image,
              noindex: source.noindex,
              nofollow: source.nofollow,
              seo_score: source.seo_score,
              score_details: source.score_details,
              last_audit: new Date().toISOString(),
            });

            perLocale[target].count++;
            perLocale[target].page_ids.push(pageId);
          }
        }

        // 4. Apply if not dry_run
        let applied = false;
        if (!dry_run && inserts.length > 0) {
          // Insert in batches of 50
          for (let i = 0; i < inserts.length; i += 50) {
            const batch = inserts.slice(i, i + 50);
            const { error: insertErr } = await client
              .from('sm_seo_meta')
              .insert(batch);
            if (insertErr) throw new Error(`Insert failed: ${insertErr.message}`);
          }
          applied = true;
        }

        const output = {
          collection,
          source_locale,
          target_locales: targets,
          source_documents: sourceRecords.length,
          total_meta_to_create: inserts.length,
          per_locale: Object.entries(perLocale).map(([loc, data]) => ({
            locale: loc,
            meta_to_create: data.count,
            already_exists: sourceRecords.length - data.count,
          })),
          applied,
          dry_run,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
