/**
 * Content Engine — CRUD operations on collections and globals
 * 
 * Tools:
 *   sm_list_collections  — List available content types with schema
 *   sm_list_documents    — List documents in a collection with pagination
 *   sm_get_document      — Get a single document with SEO meta and schemas
 *   sm_create_document   — Create a document (draft by default)
 *   sm_update_document   — Partial update of a document
 *   sm_delete_document   — Delete a document (governed)
 *   sm_update_global     — Update a global (site_config, navigation, etc.)
 *   sm_search            — Full-text search across collections
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';
import { enforceGovernance, loadGovernanceConfig } from '../shared/governance.js';

export function registerContentTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_list_collections
  // ----------------------------------------------------------
  server.registerTool(
    'sm_list_collections',
    {
      title: 'List Collections',
      description: `List all content collections defined in the Content Contract, with their schema and document counts. Use this to understand what content types the site has before querying.

Returns:
  - Array of collections with: name, table, fields, document_count, translatable`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return withAudit('sm_list_collections', 'read', context.getActiveTargetName(), {}, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract found. Run sm_discover first.');

        const client = context.getClient();
        const collections = [];

        for (const [name, config] of Object.entries(contract.collections)) {
          let count = 0;
          try {
            const { count: c } = await client
              .from(config.table)
              .select('*', { count: 'exact', head: true });
            count = c || 0;
          } catch { /* table might not be accessible */ }

          collections.push({
            name,
            table: config.table,
            slug_field: config.slug_field,
            display_field: config.display_field,
            fields: Object.entries(config.fields).map(([fname, fconfig]) => ({
              name: fname,
              type: fconfig.type,
              required: fconfig.required || false,
              translatable: fconfig.translatable || false,
            })),
            document_count: count,
            translatable: !!config.translation_table,
            translation_table: config.translation_table,
          });
        }

        const output = { collections, total: collections.length };
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_list_documents
  // ----------------------------------------------------------
  server.registerTool(
    'sm_list_documents',
    {
      title: 'List Documents',
      description: `List documents in a collection with pagination, sorting, and filtering.

Args:
  - collection: Collection name (from Content Contract)
  - limit: Max results (default 20, max 100)
  - offset: Pagination offset (default 0)
  - sort: Field to sort by (default: created_at)
  - order: Sort direction: asc or desc (default: desc)
  - search: Full-text search on display_field
  - filters: JSON object of field=value filters

Returns:
  - documents array, total count, pagination metadata`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name from Content Contract'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset'),
        sort: z.string().optional().describe('Sort field (default: created_at)'),
        order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
        search: z.string().optional().describe('Search text on display field'),
        filters: z.record(z.unknown()).optional().describe('Field=value filters'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, limit, offset, sort, order, search, filters }) => {
      return withAudit('sm_list_documents', 'list', context.getActiveTargetName(), {
        collection,
        params: { collection, limit, offset, search },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');
        
        const config = contract.collections[collection];
        if (!config) {
          const available = Object.keys(contract.collections).join(', ');
          throw new Error(`Collection "${collection}" not found. Available: ${available}`);
        }

        const client = context.getClient();
        let query = client
          .from(config.table)
          .select('*', { count: 'exact' })
          .order(sort || 'created_at', { ascending: order === 'asc' })
          .range(offset, offset + limit - 1);

        // Apply search on display field
        if (search && config.display_field) {
          query = query.ilike(config.display_field, `%${search}%`);
        }

        // Apply filters
        if (filters) {
          for (const [field, value] of Object.entries(filters)) {
            query = query.eq(field, value);
          }
        }

        const { data, count, error } = await query;
        if (error) throw new Error(`Query failed: ${error.message}`);

        const total = count || 0;
        const output = {
          collection,
          documents: data || [],
          total,
          count: (data || []).length,
          offset,
          has_more: total > offset + (data || []).length,
          next_offset: total > offset + (data || []).length ? offset + limit : undefined,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_get_document
  // ----------------------------------------------------------
  server.registerTool(
    'sm_get_document',
    {
      title: 'Get Document',
      description: `Get a single document by ID or slug, with its SEO meta, schemas, and internal links.

Args:
  - collection: Collection name
  - id: Document UUID or slug
  - locale: Locale for translations (optional)
  - include_seo: Include SEO meta (default true)
  - include_schema: Include JSON-LD schemas (default true)
  - include_links: Include internal links (default false)`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
        locale: z.string().optional().describe('Locale for translated content'),
        include_seo: z.boolean().default(true).describe('Include SEO meta'),
        include_schema: z.boolean().default(true).describe('Include JSON-LD schemas'),
        include_links: z.boolean().default(false).describe('Include internal links'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, locale, include_seo, include_schema, include_links }) => {
      return withAudit('sm_get_document', 'read', context.getActiveTargetName(), {
        collection,
        document_slug: id,
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();

        // Try by UUID first, then by slug
        let query = client.from(config.table).select('*');
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        
        if (isUuid) {
          query = query.eq('id', id);
        } else {
          query = query.eq(config.slug_field, id);
        }

        const { data: doc, error } = await query.single();
        if (error || !doc) throw new Error(`Document "${id}" not found in ${collection}.`);

        const result: Record<string, unknown> = { document: doc };

        // Fetch translations if locale specified
        if (locale && config.translation_table && config.translation_key) {
          const { data: translations } = await client
            .from(config.translation_table)
            .select('*')
            .eq(config.translation_key, doc.id)
            .eq(config.translation_locale_field || 'locale', locale);
          
          if (translations && translations.length > 0) {
            result.translation = translations[0];
          }
        }

        // Fetch SEO meta
        if (include_seo) {
          const { data: seo } = await client
            .from('sm_seo_meta')
            .select('*')
            .eq('page_type', collection)
            .eq('page_id', doc.id)
            .eq('locale', locale || contract.i18n?.default_locale || 'fr')
            .single();
          result.seo = seo || null;
        }

        // Fetch schemas
        if (include_schema) {
          const { data: schemas } = await client
            .from('sm_schema_org')
            .select('schema_type, data, validated')
            .eq('page_type', collection)
            .eq('page_id', doc.id);
          result.schemas = schemas || [];
        }

        // Fetch internal links
        if (include_links) {
          const { data: outbound } = await client
            .from('sm_internal_links')
            .select('*')
            .eq('source_type', collection)
            .eq('source_id', doc.id)
            .eq('approved', true);
          
          const { data: inbound } = await client
            .from('sm_internal_links')
            .select('*')
            .eq('target_type', collection)
            .eq('target_id', doc.id)
            .eq('approved', true);

          result.links = {
            outbound: outbound || [],
            inbound: inbound || [],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_create_document
  // ----------------------------------------------------------
  server.registerTool(
    'sm_create_document',
    {
      title: 'Create Document',
      description: `Create a new document in a collection. The document is created as draft by default.

Args:
  - collection: Collection name
  - data: JSON object with field values matching the collection schema

Returns:
  - The created document with its ID`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        data: z.record(z.unknown()).describe('Document fields matching the collection schema'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ collection, data }) => {
      const governance = loadGovernanceConfig();
      enforceGovernance('sm_create_document', governance);

      return withAudit('sm_create_document', 'create', context.getActiveTargetName(), {
        collection,
        params: { fields: Object.keys(data) },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const { data: created, error } = await client
          .from(config.table)
          .insert(data)
          .select()
          .single();

        if (error) throw new Error(`Create failed: ${error.message}`);

        return {
          content: [{ type: 'text', text: JSON.stringify({ document: created, collection }, null, 2) }],
          structuredContent: { document: created, collection },
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_update_document
  // ----------------------------------------------------------
  server.registerTool(
    'sm_update_document',
    {
      title: 'Update Document',
      description: `Partial update of a document. Only provided fields are modified.

Args:
  - collection: Collection name
  - id: Document UUID or slug
  - data: JSON object with fields to update

Returns:
  - The updated document`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
        data: z.record(z.unknown()).describe('Fields to update'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ collection, id, data }) => {
      const governance = loadGovernanceConfig();
      enforceGovernance('sm_update_document', governance);

      return withAudit('sm_update_document', 'update', context.getActiveTargetName(), {
        collection,
        document_slug: id,
        params: { fields_changed: Object.keys(data) },
        changes: data,
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const filterField = isUuid ? 'id' : config.slug_field;

        const { data: updated, error } = await client
          .from(config.table)
          .update(data)
          .eq(filterField, id)
          .select()
          .single();

        if (error) throw new Error(`Update failed: ${error.message}`);

        return {
          content: [{ type: 'text', text: JSON.stringify({ document: updated, collection, fields_updated: Object.keys(data) }, null, 2) }],
          structuredContent: { document: updated, collection, fields_updated: Object.keys(data) },
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_delete_document
  // ----------------------------------------------------------
  server.registerTool(
    'sm_delete_document',
    {
      title: 'Delete Document',
      description: `Delete a document from a collection. Blocked by SM_DISABLE_DELETE.

Args:
  - collection: Collection name
  - id: Document UUID or slug`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        id: z.string().min(1).describe('Document UUID or slug'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ collection, id }) => {
      const governance = loadGovernanceConfig();
      enforceGovernance('sm_delete_document', governance);

      return withAudit('sm_delete_document', 'delete', context.getActiveTargetName(), {
        collection,
        document_slug: id,
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const config = contract.collections[collection];
        if (!config) throw new Error(`Collection "${collection}" not found.`);

        const client = context.getClient();
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const filterField = isUuid ? 'id' : config.slug_field;

        const { error } = await client
          .from(config.table)
          .delete()
          .eq(filterField, id);

        if (error) throw new Error(`Delete failed: ${error.message}`);

        // Also clean up SEO meta, schemas, and links
        const docId = isUuid ? id : undefined;
        if (docId) {
          await client.from('sm_seo_meta').delete().eq('page_type', collection).eq('page_id', docId);
          await client.from('sm_schema_org').delete().eq('page_type', collection).eq('page_id', docId);
          await client.from('sm_internal_links').delete().or(`source_id.eq.${docId},target_id.eq.${docId}`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ deleted: true, collection, id }, null, 2) }],
          structuredContent: { deleted: true, collection, id },
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_update_global
  // ----------------------------------------------------------
  server.registerTool(
    'sm_update_global',
    {
      title: 'Update Global',
      description: `Update a global configuration (site_config, seo_config, navigation). Supports partial updates — only provided fields are merged.

Args:
  - key: Global key (site_config, seo_config, navigation)
  - data: JSON object with fields to update (merged with existing data)

Example: sm_update_global({key: "site_config", data: {phone: "04 123 45 67"}})`,
      inputSchema: {
        key: z.string().min(1).describe('Global key: site_config, seo_config, navigation'),
        data: z.record(z.unknown()).describe('Fields to update (merged with existing)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ key, data }) => {
      const governance = loadGovernanceConfig();
      enforceGovernance('sm_update_global', governance);

      return withAudit('sm_update_global', 'update', context.getActiveTargetName(), {
        params: { key, fields_changed: Object.keys(data) },
        changes: data,
      }, async () => {
        if (key === '_content_contract') {
          throw new Error('Cannot update Content Contract via sm_update_global. Use sm_discover with save=true.');
        }

        const client = context.getClient();

        // Get existing data
        const { data: existing, error: readError } = await client
          .from('sm_globals')
          .select('data')
          .eq('key', key)
          .single();

        if (readError) throw new Error(`Global "${key}" not found.`);

        // Merge
        const merged = { ...existing.data, ...data };

        const { error: writeError } = await client
          .from('sm_globals')
          .update({ data: merged })
          .eq('key', key);

        if (writeError) throw new Error(`Update failed: ${writeError.message}`);

        return {
          content: [{ type: 'text', text: JSON.stringify({ key, data: merged, fields_updated: Object.keys(data) }, null, 2) }],
          structuredContent: { key, data: merged, fields_updated: Object.keys(data) },
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_search
  // ----------------------------------------------------------
  server.registerTool(
    'sm_search',
    {
      title: 'Search Content',
      description: `Full-text search across one or all collections.

Args:
  - query: Search text
  - collection: Specific collection to search (optional, searches all if omitted)
  - limit: Max results (default 20)

Returns:
  - Results grouped by collection`,
      inputSchema: {
        query: z.string().min(1).describe('Search text'),
        collection: z.string().optional().describe('Specific collection (omit for all)'),
        limit: z.number().int().min(1).max(50).default(20).describe('Max results per collection'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, collection, limit }) => {
      return withAudit('sm_search', 'search', context.getActiveTargetName(), {
        params: { query, collection },
      }, async () => {
        const contract = await context.loadContract();
        if (!contract) throw new Error('No Content Contract. Run sm_discover first.');

        const client = context.getClient();
        const collectionsToSearch = collection
          ? { [collection]: contract.collections[collection] }
          : contract.collections;

        const results: Record<string, unknown[]> = {};
        let totalFound = 0;

        for (const [name, config] of Object.entries(collectionsToSearch)) {
          if (!config) continue;

          const displayField = config.display_field || config.slug_field;
          
          try {
            const { data, error } = await client
              .from(config.table)
              .select('*')
              .ilike(displayField, `%${query}%`)
              .limit(limit);

            if (!error && data && data.length > 0) {
              results[name] = data;
              totalFound += data.length;
            }
          } catch { /* skip inaccessible tables */ }
        }

        const output = { query, results, total_found: totalFound };
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}
