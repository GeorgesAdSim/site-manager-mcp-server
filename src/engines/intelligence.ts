/**
 * Intelligence Engine — SEO keyword suggestions and growth priorities
 *
 * Tools:
 *   sm_suggest_keywords   — Propose SEO keywords based on content analysis
 *   sm_growth_priorities  — Top N highest-impact actions to improve the site
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';

// ============================================================
// French stop words
// ============================================================

const STOP_WORDS_FR = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'en',
  'pour', 'avec', 'est', 'dans', 'qui', 'que', 'sur', 'par', 'au',
  'aux', 'ce', 'cette', 'son', 'ses', 'plus', 'pas', 'tout', 'mais',
  'ou', 'donc', 'ni', 'car', 'ne', 'se', 'sa', 'il', 'elle', 'on',
  'nous', 'vous', 'ils', 'elles', 'leur', 'leurs', 'être', 'avoir',
  'fait', 'faire', 'comme', 'très', 'aussi', 'bien', 'si', 'peut',
  'tous', 'même', 'ces', 'deux', 'entre', 'sans', 'sous', 'a', 'à',
  'the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'on', 'at',
  'by', 'an', 'it', 'as', 'from', 'or', 'be', 'are', 'was', 'has',
]);

const TRANSACTIONAL_SIGNALS = new Set([
  'acheter', 'prix', 'devis', 'professionnel', 'professionnelle',
  'industriel', 'industrielle', 'commercial', 'vente', 'achat',
  'commander', 'fournisseur', 'fabricant', 'distributeur', 'catalogue',
  'gamme', 'modèle', 'série', 'machine', 'équipement',
]);

// ============================================================
// Text analysis helpers
// ============================================================

function extractNgrams(text: string, maxN: number): Map<string, number> {
  const cleaned = text
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-zàâäéèêëïîôùûüÿçœæ\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 2 && !STOP_WORDS_FR.has(w));
  const counts = new Map<string, number>();

  // Unigrams
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }

  // Bigrams and trigrams
  for (let n = 2; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const ngram = words.slice(i, i + n).join(' ');
      counts.set(ngram, (counts.get(ngram) || 0) + 1);
    }
  }

  return counts;
}

function classifyIntent(keyword: string): 'transactional' | 'informational' {
  const words = keyword.toLowerCase().split(' ');
  for (const w of words) {
    if (TRANSACTIONAL_SIGNALS.has(w)) return 'transactional';
  }
  if (/comment|guide|fonctionnement|comparatif|avis|différence|quel|choisir/.test(keyword)) {
    return 'informational';
  }
  return 'transactional'; // default for product pages
}

// ============================================================
// Register Intelligence tools
// ============================================================

export function registerIntelligenceTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_suggest_keywords
  // ----------------------------------------------------------
  server.registerTool(
    'sm_suggest_keywords',
    {
      title: 'Suggest SEO Keywords',
      description: `Propose SEO keywords for documents based on content analysis (TF on name, description, subtitle, category). Classifies each keyword as transactional or informational.

Args:
  - collection: Collection name (default "machines")
  - id: Optional document UUID or slug (if omitted, processes the whole collection)
  - locale: Locale (default "fr")
  - limit: Max documents in collection mode (default 10)

Returns:
  - Per-document keyword suggestions with intent, source, and recommendation`,
      inputSchema: {
        collection: z.string().default('machines').describe('Collection name'),
        id: z.string().optional().describe('Document UUID or slug (optional)'),
        locale: z.string().default('fr').describe('Locale'),
        limit: z.number().int().min(1).max(100).default(10).describe('Max documents'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, locale, limit }) => {
      return withAudit('sm_suggest_keywords', 'audit', context.getActiveTargetName(), {
        collection,
        document_slug: id,
        params: { locale, limit },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const i18nStrategy = contract.i18n?.strategy || 'column';
        const defaultLocale = contract.i18n?.default_locale || 'fr';
        const isDefault = locale === defaultLocale;

        // 1. Fetch document(s)
        let query = client.from(config.table).select('*');
        if (id) {
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
          query = isUuid ? query.eq('id', id) : query.eq(config.slug_field, id);
        } else {
          query = query.order('created_at', { ascending: false }).limit(limit);
        }

        const { data: docs, error: docsErr } = id ? await query.single().then(r => ({ data: r.data ? [r.data] : null, error: r.error })) : await query;
        if (docsErr || !docs || docs.length === 0) throw new Error(`No documents found.`);

        // 2. Fetch categories
        const { data: catData } = await client.from('categories').select('id, name, slug');
        const categoryMap = new Map<string, Record<string, unknown>>();
        for (const cat of (catData || []) as Record<string, unknown>[]) {
          categoryMap.set(cat.id as string, cat);
        }

        // 3. Fetch existing SEO meta
        const docIds = (docs as unknown as Record<string, unknown>[]).map(d => d.id as string);
        const { data: seoData } = await client
          .from('sm_seo_meta')
          .select('page_id, focus_keyword')
          .eq('page_type', collection)
          .eq('locale', locale)
          .in('page_id', docIds);

        const focusByPageId = new Map<string, string | null>();
        for (const row of (seoData || []) as Record<string, unknown>[]) {
          focusByPageId.set(row.page_id as string, (row.focus_keyword as string | null) || null);
        }

        // Helper: localized field
        function getLocalized(machine: Record<string, unknown>, base: string): string {
          if (i18nStrategy === 'suffix' && !isDefault) {
            const v = machine[`${base}_${locale}`];
            if (v) return String(v);
          }
          if (machine[base] != null) return String(machine[base]);
          if (i18nStrategy === 'suffix') {
            const v = machine[`${base}_${defaultLocale}`];
            if (v) return String(v);
          }
          return '';
        }

        // 4. Analyze each document
        const results: {
          document_id: string;
          slug: string;
          name: string;
          current_focus_keyword: string | null;
          suggestions: {
            keyword: string;
            intent: string;
            source: string;
            recommended_as: string;
            frequency: number;
          }[];
          recommended_focus: string | null;
        }[] = [];

        for (const doc of docs as unknown as Record<string, unknown>[]) {
          const docId = doc.id as string;
          const machineSlug = (doc[config.slug_field] || '') as string;
          const machineName = getLocalized(doc, 'name') || getLocalized(doc, 'title') ||
            (config.display_field ? doc[config.display_field] as string : machineSlug);
          const machineDesc = getLocalized(doc, 'description') || '';
          const machineSubtitle = getLocalized(doc, 'subtitle') || '';
          const catId = doc.category_id as string | null;
          const cat = catId ? categoryMap.get(catId) : null;
          const catName = cat ? (cat.name as string) : '';

          // Build full text corpus
          const corpus = [machineName, machineSubtitle, machineDesc, catName].join(' ');
          const ngrams = extractNgrams(corpus, 3);

          // Build candidate keywords
          const candidates: {
            keyword: string;
            source: string;
            frequency: number;
            intent: string;
          }[] = [];

          // Title-based keywords
          const nameClean = machineName.toLowerCase().replace(/[^a-zàâäéèêëïîôùûüÿçœæ\s-]/g, '').trim();
          if (nameClean.length > 2) {
            candidates.push({
              keyword: nameClean,
              source: 'title',
              frequency: ngrams.get(nameClean) || 1,
              intent: classifyIntent(nameClean),
            });
          }

          // Category-based keywords
          if (catName) {
            const catClean = catName.toLowerCase().replace(/[^a-zàâäéèêëïîôùûüÿçœæ\s-]/g, '').trim();
            if (catClean.length > 2) {
              candidates.push({
                keyword: catClean,
                source: 'category',
                frequency: ngrams.get(catClean) || 1,
                intent: classifyIntent(catClean),
              });
            }
            // Combine: name + category type
            const combined = `${nameClean} ${catClean.split(' ')[0]}`;
            if (combined.split(' ').length <= 3) {
              candidates.push({
                keyword: combined,
                source: 'title+category',
                frequency: 1,
                intent: 'transactional',
              });
            }
          }

          // Content-based: top ngrams by frequency
          const sorted = [...ngrams.entries()]
            .filter(([k, v]) => v >= 2 && k.length > 3 && !STOP_WORDS_FR.has(k))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

          for (const [keyword, freq] of sorted) {
            // Avoid duplicating title/category
            if (candidates.some(c => c.keyword === keyword)) continue;
            candidates.push({
              keyword,
              source: 'content',
              frequency: freq,
              intent: classifyIntent(keyword),
            });
          }

          // Deduplicate and rank
          const seen = new Set<string>();
          const suggestions: { keyword: string; intent: string; source: string; recommended_as: string; frequency: number }[] = [];
          for (const c of candidates) {
            if (seen.has(c.keyword)) continue;
            seen.add(c.keyword);

            let recommended_as = 'secondary';
            if (c.source === 'title' || (c.source === 'title+category' && c.intent === 'transactional')) {
              recommended_as = 'focus_keyword';
            } else if (c.keyword.split(' ').length >= 3) {
              recommended_as = 'long_tail';
            }

            suggestions.push({ keyword: c.keyword, intent: c.intent, source: c.source, frequency: c.frequency, recommended_as });
            if (suggestions.length >= 5) break;
          }

          // Recommended focus keyword
          const currentFocus = focusByPageId.get(docId) || null;
          let recommendedFocus: string | null = null;
          if (!currentFocus) {
            const best = suggestions.find(s => s.recommended_as === 'focus_keyword' && s.intent === 'transactional');
            recommendedFocus = best?.keyword || suggestions[0]?.keyword || null;
          }

          results.push({
            document_id: docId,
            slug: machineSlug,
            name: machineName,
            current_focus_keyword: currentFocus,
            suggestions,
            recommended_focus: recommendedFocus,
          });
        }

        const output = {
          collection,
          locale,
          documents_analyzed: results.length,
          documents_missing_focus: results.filter(r => !r.current_focus_keyword).length,
          results,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_growth_priorities
  // ----------------------------------------------------------
  server.registerTool(
    'sm_growth_priorities',
    {
      title: 'Growth Priorities',
      description: `Cross-reference all SEO data to return the top N highest-impact actions. Analyzes SEO scores, schema coverage, orphan pages, meta completeness, and score trends.

Args:
  - locale: Locale (default "fr")
  - top: Number of priorities to return (default 5)

Returns:
  - Ranked list of priorities with issues, recommended actions, estimated impact, and MCP commands
  - Summary with estimated score after corrections`,
      inputSchema: {
        locale: z.string().default('fr').describe('Locale'),
        top: z.number().int().min(1).max(20).default(5).describe('Number of priorities'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ locale, top }) => {
      return withAudit('sm_growth_priorities', 'audit', context.getActiveTargetName(), {
        params: { locale, top },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const client = context.getClient();

        // 1. Fetch all SEO meta
        const { data: seoData } = await client
          .from('sm_seo_meta')
          .select('*')
          .eq('locale', locale);

        const seoRecords = (seoData || []) as Record<string, unknown>[];
        if (seoRecords.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              locale,
              message: 'No SEO data found. Run sm_audit_seo first.',
              priorities: [],
            }, null, 2) }],
          };
        }

        // 2. Fetch schema coverage
        const seoPageIds = seoRecords.map(r => r.page_id as string);
        const { data: schemaData } = await client
          .from('sm_schema_org')
          .select('page_id, schema_type')
          .in('page_id', seoPageIds);

        const pagesWithSchema = new Set(
          ((schemaData || []) as Record<string, unknown>[]).map(r => r.page_id as string)
        );

        // 3. Fetch internal links (inbound)
        const { data: linksData } = await client
          .from('sm_internal_links')
          .select('target_id')
          .eq('approved', true)
          .in('target_id', seoPageIds);

        const pagesWithInbound = new Set(
          ((linksData || []) as Record<string, unknown>[]).map(r => r.target_id as string)
        );

        // 4. Fetch last audit scores for trend
        const { data: historyData } = await client
          .from('sm_seo_history')
          .select('avg_score, audited_at')
          .eq('locale', locale)
          .order('audited_at', { ascending: false })
          .limit(1);

        const lastAvgScore = historyData && historyData.length > 0
          ? (historyData[0] as Record<string, unknown>).avg_score as number
          : null;

        // 5. Score each page
        const scored: {
          page_type: string;
          page_id: string;
          page_title: string;
          current_score: number;
          priority_score: number;
          issues: string[];
          actions: string[];
          estimated_impact: string;
          quick_command: string;
        }[] = [];

        for (const seo of seoRecords) {
          const pageId = seo.page_id as string;
          const pageType = seo.page_type as string;
          const title = (seo.meta_title as string | null) || '(no title)';
          const seoScore = seo.seo_score as number;
          const metaDesc = (seo.meta_description as string | null)?.trim();
          const focusKw = (seo.focus_keyword as string | null)?.trim();

          let priorityScore = 0;
          const issues: string[] = [];
          const actions: string[] = [];

          // SEO score < 50
          if (seoScore < 50) {
            priorityScore += 40;
            issues.push(`Low SEO score: ${seoScore}/100`);
            actions.push('Run sm_auto_fix_seo to generate missing meta');
          }

          // Schema missing
          if (!pagesWithSchema.has(pageId)) {
            priorityScore += 20;
            issues.push('No JSON-LD schema');
            actions.push(`Generate schema: sm_generate_schema({collection:"${pageType}",id:"${pageId}",dry_run:false})`);
          }

          // Orphan page (no inbound links)
          if (!pagesWithInbound.has(pageId)) {
            priorityScore += 30;
            issues.push('Orphan page — no inbound internal links');
            actions.push('Run sm_suggest_internal_links to create link suggestions');
          }

          // Meta description missing
          if (!metaDesc) {
            priorityScore += 25;
            issues.push('Meta description missing');
            actions.push('Add meta description via sm_update_seo_meta or sm_auto_fix_seo');
          }

          // Focus keyword missing
          if (!focusKw) {
            priorityScore += 15;
            issues.push('Focus keyword missing');
            actions.push('Run sm_suggest_keywords then set via sm_update_seo_meta');
          }

          // Score trending down
          if (lastAvgScore !== null && seoScore < lastAvgScore - 5) {
            priorityScore += 10;
            issues.push(`Score dropped vs last audit (avg was ${lastAvgScore})`);
            actions.push('Review and update SEO meta');
          }

          if (priorityScore === 0) continue;

          const impact = priorityScore >= 50 ? 'high' : priorityScore >= 25 ? 'medium' : 'low';
          const mainCommand = seoScore < 50
            ? `sm_auto_fix_seo({collection:"${pageType}",locale:"${locale}",confirm:true})`
            : issues.includes('No JSON-LD schema')
              ? `sm_generate_schema({collection:"${pageType}",id:"${pageId}",dry_run:false})`
              : `sm_update_seo_meta({collection:"${pageType}",id:"${pageId}",locale:"${locale}",data:{...}})`;

          scored.push({
            page_type: pageType,
            page_id: pageId,
            page_title: title,
            current_score: seoScore,
            priority_score: priorityScore,
            issues,
            actions,
            estimated_impact: impact,
            quick_command: mainCommand,
          });
        }

        // 6. Sort and take top N
        scored.sort((a, b) => b.priority_score - a.priority_score);
        const priorities = scored.slice(0, top).map((p, i) => ({
          rank: i + 1,
          ...p,
        }));

        // 7. Summary
        const highCount = priorities.filter(p => p.estimated_impact === 'high').length;
        const medCount = priorities.filter(p => p.estimated_impact === 'medium').length;
        const lowCount = priorities.filter(p => p.estimated_impact === 'low').length;

        const currentAvg = seoRecords.length > 0
          ? Math.round(seoRecords.reduce((acc, r) => acc + (r.seo_score as number), 0) / seoRecords.length)
          : 0;

        // Estimate improvement: each high action ~+5pts, medium ~+3pts, low ~+1pt
        const estimatedGain = highCount * 5 + medCount * 3 + lowCount * 1;
        const estimatedScore = Math.min(100, currentAvg + estimatedGain);

        const summary = `${highCount} high-impact, ${medCount} medium, ${lowCount} low. ` +
          `Current avg score: ${currentAvg}/100. ` +
          `Estimated after corrections: ~${estimatedScore}/100 (+${estimatedGain}pts).`;

        const output = {
          locale,
          total_pages_analyzed: seoRecords.length,
          pages_with_issues: scored.length,
          current_avg_score: currentAvg,
          estimated_score_after: estimatedScore,
          summary,
          priorities,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
