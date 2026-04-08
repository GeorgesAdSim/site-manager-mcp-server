/**
 * Shared Helpers — Reusable utilities for all engines
 *
 *   getLocalized()      — Resolve an i18n suffix field (name_en, description_de, etc.)
 *   resolveDocument()   — Lookup a document by UUID or slug
 *   fetchCategories()   — Fetch categories with in-memory TTL cache
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentContract, CollectionConfig } from '../types.js';

// ============================================================
// UUID regex
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ============================================================
// getLocalized
// ============================================================

/**
 * Resolve a field value respecting the i18n suffix strategy.
 *
 * For suffix strategy (e.g. JAC Machines): tries `field_locale` first,
 * then `field` (base), then `field_defaultLocale` as fallback.
 *
 * @returns The resolved string value, or `null` if not found.
 */
export function getLocalized(
  doc: Record<string, unknown>,
  field: string,
  locale: string,
  contract: ContentContract,
): string | null {
  const strategy = contract.i18n?.strategy || 'column';
  const defaultLocale = contract.i18n?.default_locale || 'fr';
  const isDefault = locale === defaultLocale;

  // Suffix strategy: try field_locale first
  if (strategy === 'suffix' && !isDefault) {
    const v = doc[`${field}_${locale}`];
    if (v != null && String(v).trim() !== '') return String(v);
  }

  // Base field
  if (doc[field] != null && String(doc[field]).trim() !== '') return String(doc[field]);

  // Suffix fallback: try field_defaultLocale
  if (strategy === 'suffix' && !isDefault) {
    const v = doc[`${field}_${defaultLocale}`];
    if (v != null && String(v).trim() !== '') return String(v);
  }

  return null;
}

// ============================================================
// resolveDocument
// ============================================================

/**
 * Fetch a single document by UUID or slug from a collection.
 *
 * @returns The document record.
 * @throws Error if the document is not found.
 */
export async function resolveDocument(
  client: SupabaseClient,
  contract: ContentContract,
  collection: string,
  idOrSlug: string,
): Promise<Record<string, unknown>> {
  const config = contract.collections[collection];
  if (!config) {
    const available = Object.keys(contract.collections).join(', ');
    throw new Error(`Collection "${collection}" not found. Available: ${available}`);
  }

  const filterField = isUuid(idOrSlug) ? 'id' : config.slug_field;

  const { data, error } = await client
    .from(config.table)
    .select('*')
    .eq(filterField, idOrSlug)
    .single();

  if (error || !data) {
    throw new Error(`Document "${idOrSlug}" not found in ${collection}.`);
  }

  return data as Record<string, unknown>;
}

/**
 * Resolve a document ID (UUID) from either a UUID or slug.
 */
export async function resolveDocumentId(
  client: SupabaseClient,
  config: CollectionConfig,
  idOrSlug: string,
): Promise<string> {
  if (isUuid(idOrSlug)) return idOrSlug;

  const { data, error } = await client
    .from(config.table)
    .select('id')
    .eq(config.slug_field, idOrSlug)
    .single();

  if (error || !data) {
    throw new Error(`Document "${idOrSlug}" not found.`);
  }

  return (data as Record<string, unknown>).id as string;
}

// ============================================================
// fetchCategories (cached)
// ============================================================

let _categoryCache: Map<string, Record<string, unknown>> | null = null;
let _categoryCacheTimestamp = 0;
const CATEGORY_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Fetch all categories with a 60-second in-memory cache.
 *
 * Returns a Map of category ID → category record.
 * Tries to include `parent_id` column; if it doesn't exist, queries without it.
 */
export async function fetchCategories(
  client: SupabaseClient,
): Promise<Map<string, Record<string, unknown>>> {
  const now = Date.now();

  if (_categoryCache && (now - _categoryCacheTimestamp) < CATEGORY_CACHE_TTL_MS) {
    return _categoryCache;
  }

  const map = new Map<string, Record<string, unknown>>();

  // Try with parent_id first
  const { data: withParent, error: err1 } = await client
    .from('categories')
    .select('id, name, slug, parent_id');

  let rows: Record<string, unknown>[];

  if (err1) {
    // parent_id column might not exist — fallback
    const { data: withoutParent } = await client
      .from('categories')
      .select('id, name, slug');
    rows = (withoutParent || []) as Record<string, unknown>[];
  } else {
    rows = (withParent || []) as Record<string, unknown>[];
  }

  for (const row of rows) {
    map.set(row.id as string, row);
  }

  _categoryCache = map;
  _categoryCacheTimestamp = now;

  return map;
}

/**
 * Invalidate the category cache (e.g. after category changes).
 */
export function invalidateCategoryCache(): void {
  _categoryCache = null;
  _categoryCacheTimestamp = 0;
}
