/**
 * Manual test — connect to JAC Machines Supabase and run full introspection
 *
 * Usage: npx tsx tests/manual-test.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env
const envPath = resolve(import.meta.dirname, '..', '.env');
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE_URL = process.env.SITE_URL || 'https://jac-machines.media';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ============================================================
// Helper: probe a table — returns sample row keys + count, or null
// ============================================================

async function probeTable(name: string): Promise<{ count: number; fields: string[]; sample: Record<string, unknown> | null } | null> {
  // Try count first (works even on views exposed via API)
  const { count, error: countErr } = await client
    .from(name)
    .select('*', { count: 'exact', head: true });

  if (countErr) return null;

  // Get a sample row for field discovery
  const { data: rows } = await client.from(name).select('*').limit(1);
  const sample = rows && rows.length > 0 ? rows[0] as Record<string, unknown> : null;
  const fields = sample ? Object.keys(sample) : [];

  return { count: count ?? 0, fields, sample };
}

// ============================================================
// STEP 1: Discover all tables by probing a broad list
// ============================================================

async function discoverTables() {
  console.log('='.repeat(60));
  console.log('STEP 1: Discovering all accessible tables');
  console.log('='.repeat(60));

  // JAC Machines known tables + sm_* tables
  const candidates = [
    // Known JAC content tables
    'machines', 'categories', 'media_items', 'specifications',
    'glossary', 'page_configs', 'document_embeddings',
    'media_statistics', 'video_stats', 'user_roles',
    // Views / materialized
    'machines_with_categories', 'machines_with_translations',
    'machines_with_media', 'machines_with_specs',
    // SM tables
    'sm_globals', 'sm_seo_meta', 'sm_schema_org', 'sm_internal_links',
    'sm_audit_log', 'sm_changelog', 'sm_media', 'sm_redirects',
  ];

  const found: { name: string; count: number; fields: string[] }[] = [];

  // Probe all in parallel batches
  const results = await Promise.all(
    candidates.map(async (name) => {
      const result = await probeTable(name);
      return { name, result };
    })
  );

  for (const { name, result } of results) {
    if (result) {
      found.push({ name, count: result.count, fields: result.fields });
    }
  }

  // Sort: sm_ tables last, then alphabetical
  found.sort((a, b) => {
    const aIsSm = a.name.startsWith('sm_') ? 1 : 0;
    const bIsSm = b.name.startsWith('sm_') ? 1 : 0;
    if (aIsSm !== bIsSm) return aIsSm - bIsSm;
    return a.name.localeCompare(b.name);
  });

  console.log(`\nFound ${found.length} accessible tables:\n`);
  for (const t of found) {
    const tag = t.name.startsWith('sm_') ? ' [SM]' : '';
    console.log(`  ${t.name}${tag} — ${t.count} rows — fields: ${t.fields.join(', ') || '(empty)'}`);
  }

  return found;
}

// ============================================================
// STEP 2: Deep inspection of content tables
// ============================================================

async function inspectContentTables(tables: { name: string; count: number; fields: string[] }[]) {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 2: Deep inspection of content tables');
  console.log('='.repeat(60));

  const contentTables = tables.filter(t => !t.name.startsWith('sm_'));

  for (const t of contentTables) {
    console.log(`\n  ── ${t.name} (${t.count} rows) ──`);

    // Show fields with types inferred from sample
    const { data: rows } = await client.from(t.name).select('*').limit(1);
    if (rows && rows.length > 0) {
      const sample = rows[0] as Record<string, unknown>;
      for (const [key, value] of Object.entries(sample)) {
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const preview = value === null ? 'null'
          : typeof value === 'string' ? `"${value.length > 60 ? value.slice(0, 60) + '…' : value}"`
          : typeof value === 'object' ? JSON.stringify(value).slice(0, 80)
          : String(value);
        console.log(`    ${key}: ${type} = ${preview}`);
      }
    } else {
      console.log(`    (no data — fields: ${t.fields.join(', ')})`);
    }

    // Detect if this is a translation table
    const hasLocale = t.fields.some(f => ['locale', 'language', 'lang', 'language_code'].includes(f));
    const hasFk = t.fields.some(f => f.endsWith('_id') && f !== 'id');
    if (hasLocale) {
      console.log(`    → Translation table detected (locale field + foreign key: ${hasFk})`);

      // Get distinct locales
      const localeField = t.fields.find(f => ['locale', 'language', 'lang', 'language_code'].includes(f))!;
      const { data: localeRows } = await client
        .from(t.name)
        .select(localeField)
        .limit(500);

      if (localeRows) {
        const locales = [...new Set((localeRows as Record<string, unknown>[]).map(r => r[localeField]))].sort();
        console.log(`    → Locales found: ${(locales as string[]).join(', ')} (${locales.length} total)`);
      }
    }

    // Detect slug field
    const slugField = t.fields.find(f => ['slug', 'url_slug', 'permalink'].includes(f));
    if (slugField) console.log(`    → Slug field: ${slugField}`);

    // Detect display field
    const displayField = t.fields.find(f => ['name', 'title', 'label'].includes(f));
    if (displayField) console.log(`    → Display field: ${displayField}`);
  }
}

// ============================================================
// STEP 3: Check sm_globals content
// ============================================================

async function checkSmGlobals() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 3: sm_globals content');
  console.log('='.repeat(60));

  const { data, error } = await client
    .from('sm_globals')
    .select('key, data');

  if (error) {
    console.log(`  ✗ ${error.message}`);
    return;
  }

  for (const row of (data || []) as { key: string; data: unknown }[]) {
    console.log(`\n  ── ${row.key} ──`);
    console.log(`  ${JSON.stringify(row.data, null, 2).split('\n').join('\n  ')}`);
  }
}

// ============================================================
// STEP 4: Generate Content Contract (dry run)
// ============================================================

async function generateContract(tables: { name: string; count: number; fields: string[] }[]) {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 4: Generated Content Contract (dry run)');
  console.log('='.repeat(60));

  const contentTables = tables.filter(t => !t.name.startsWith('sm_'));
  const smTables = tables.filter(t => t.name.startsWith('sm_'));

  // Detect translation tables
  const translationTables = contentTables.filter(t =>
    t.fields.some(f => ['locale', 'language', 'lang'].includes(f)) &&
    t.fields.some(f => f.endsWith('_id') && f !== 'id')
  );
  const translationNames = new Set(translationTables.map(t => t.name));

  // Detect locales from first translation table
  let locales: string[] = ['fr'];
  if (translationTables.length > 0) {
    const t = translationTables[0];
    const localeField = t.fields.find(f => ['locale', 'language', 'lang'].includes(f))!;
    const { data: localeRows } = await client.from(t.name).select(localeField).limit(500);
    if (localeRows) {
      locales = [...new Set((localeRows as Record<string, unknown>[]).map(r => String(r[localeField])))].sort();
    }
  }

  // Build collections from non-translation content tables
  const collections: Record<string, unknown> = {};
  for (const t of contentTables) {
    if (translationNames.has(t.name)) continue;

    // Find matching translation table
    const transTable = translationTables.find(tr =>
      tr.name === `${t.name}_translations` ||
      tr.name === `${t.name}_translation` ||
      tr.name === `${t.name}_i18n`
    );

    const slugField = t.fields.find(f => ['slug', 'url_slug', 'permalink'].includes(f));
    const displayField = t.fields.find(f => ['name', 'title', 'label'].includes(f));

    collections[t.name] = {
      table: t.name,
      slug_field: slugField || 'id',
      display_field: displayField,
      translation_table: transTable?.name,
      fields: t.fields.filter(f => !['id', 'created_at', 'updated_at'].includes(f)),
      document_count: t.count,
    };
  }

  const contract = {
    version: '1.0',
    generated_by: 'manual-test',
    generated_at: new Date().toISOString(),
    site: {
      name: 'JAC Machines',
      url: SITE_URL,
      stack: 'react-vite',
      onboarding_mode: 'existing_supabase',
    },
    content_mode: 'supabase',
    backend: {
      supabase: {
        project_ref: SUPABASE_URL.split('//')[1]?.split('.')[0] || '',
        url: SUPABASE_URL,
      },
    },
    collections,
    i18n: {
      enabled: locales.length > 1,
      default_locale: locales.includes('fr') ? 'fr' : locales[0],
      locales,
      strategy: 'translation_table',
      seo_sync: true,
    },
    sm_tables_found: smTables.map(t => t.name),
  };

  console.log('\n' + JSON.stringify(contract, null, 2));

  // Summary
  console.log('\n' + '─'.repeat(60));
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  console.log(`  Collections:        ${Object.keys(collections).length}`);
  console.log(`  Translation tables: ${translationTables.length} (${translationNames.size > 0 ? [...translationNames].join(', ') : 'none'})`);
  console.log(`  Locales:            ${locales.length} — ${locales.join(', ')}`);
  console.log(`  SM tables:          ${smTables.length} — ${smTables.map(t => t.name).join(', ')}`);
}

// ============================================================
// STEP 5: Show sample data for machines + categories
// ============================================================

async function showSampleData() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 5: Sample data — machines (limit 2) + categories (limit 2)');
  console.log('='.repeat(60));

  for (const table of ['machines', 'categories']) {
    const { data, error } = await client.from(table).select('*').limit(2);
    console.log(`\n  ── ${table} ──`);
    if (error) {
      console.log(`  ✗ ${error.message}`);
    } else if (!data || data.length === 0) {
      console.log(`  (empty)`);
    } else {
      console.log(JSON.stringify(data, null, 2).split('\n').map(l => '  ' + l).join('\n'));
    }
  }
}

// ============================================================
// Run
// ============================================================

async function main() {
  console.log(`\n${'*'.repeat(60)}`);
  console.log(`  @adsim/site-manager-mcp-server — Manual Test`);
  console.log(`  Target: ${SUPABASE_URL}`);
  console.log(`  Site:   ${SITE_URL}`);
  console.log(`${'*'.repeat(60)}\n`);

  const tables = await discoverTables();
  await inspectContentTables(tables);
  await checkSmGlobals();
  await showSampleData();
  await generateContract(tables);

  console.log('\n' + '='.repeat(60));
  console.log('TEST COMPLETE');
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
