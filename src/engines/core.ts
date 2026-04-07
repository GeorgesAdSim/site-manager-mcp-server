/**
 * Core Engine — Site introspection and target management
 * 
 * Tools:
 *   sm_site_info        — Site overview + Content Contract + governance status
 *   sm_discover         — Auto-discover schema and generate Content Contract
 *   sm_set_target       — Switch active site (multi-target)
 *   sm_get_site_options — Read globals (config, SEO, navigation)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as context from '../shared/context.js';
import { withAudit } from '../shared/audit.js';
import { loadGovernanceConfig } from '../shared/governance.js';
import type { ContentContract, DiscoveryResult, SuggestedCollection, TableInfo, ColumnInfo, FieldConfig } from '../types.js';

// ============================================================
// Register all core tools
// ============================================================

export function registerCoreTools(server: McpServer): void {

  // ----------------------------------------------------------
  // sm_site_info
  // ----------------------------------------------------------
  server.registerTool(
    'sm_site_info',
    {
      title: 'Site Info',
      description: `Get complete site overview: Content Contract, collections, globals, i18n config, governance status, and active target. Call this first to understand the site before performing any operations.

Returns:
  - site: name, url, stack, onboarding mode
  - content_mode: supabase or files
  - collections: list with document counts
  - globals: available global configs
  - i18n: languages and coverage
  - governance: active controls (read_only, disable_delete, etc.)
  - targets: all configured sites and active target`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      return withAudit('sm_site_info', 'read', context.getActiveTargetName(), {}, async () => {
        const contract = await context.loadContract();
        const governance = loadGovernanceConfig();
        const client = context.getClient();

        // Get document counts per collection
        const collectionStats: Record<string, number> = {};
        if (contract?.collections) {
          for (const [name, config] of Object.entries(contract.collections)) {
            try {
              const { count } = await client
                .from(config.table)
                .select('*', { count: 'exact', head: true });
              collectionStats[name] = count || 0;
            } catch {
              collectionStats[name] = -1; // table not accessible
            }
          }
        }

        // Get global SEO stats
        let seoStats = { total: 0, avg_score: 0, below_threshold: 0 };
        try {
          const { data: seoData } = await client
            .from('sm_seo_meta')
            .select('seo_score');
          if (seoData && seoData.length > 0) {
            const scores = (seoData as unknown as { seo_score: number }[]).map(d => d.seo_score);
            seoStats = {
              total: scores.length,
              avg_score: Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length),
              below_threshold: scores.filter((s: number) => s < (contract?.seo?.score_threshold || 50)).length,
            };
          }
        } catch { /* tables might not have data yet */ }

        const output = {
          site: contract?.site || { name: 'Not configured', url: '', stack: 'unknown', onboarding_mode: 'overlay' },
          content_mode: contract?.content_mode || 'supabase',
          collections: Object.entries(contract?.collections || {}).map(([name, config]) => ({
            name,
            table: config.table,
            fields: Object.keys(config.fields).length,
            documents: collectionStats[name] || 0,
            translatable: !!config.translation_table,
          })),
          globals: Object.keys(contract?.globals || {}),
          i18n: contract?.i18n || { enabled: false, default_locale: 'fr', locales: ['fr'] },
          seo: seoStats,
          governance: {
            read_only: governance.readOnly,
            disable_delete: governance.disableDelete,
            confirm_deploy: governance.confirmDeploy,
            audit_log: governance.auditLog,
            content_mode: governance.contentMode,
            deploy_target: governance.deployTarget,
            tool_categories: governance.toolCategories.length > 0 ? governance.toolCategories : ['all'],
          },
          targets: {
            active: context.getActiveTargetName(),
            available: context.getTargetNames(),
          },
          contract_loaded: !!contract,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_discover
  // ----------------------------------------------------------
  server.registerTool(
    'sm_discover',
    {
      title: 'Discover Site Schema',
      description: `Auto-discover the database schema of the current Supabase project and generate a Content Contract. Introspects all tables, detects collections, translation tables, i18n patterns, and existing sm_* tables.

Use this to onboard an existing site — the generated Content Contract can be reviewed, edited, and saved.

Args:
  - save: If true, saves the generated contract to sm_globals. Default false (dry run).
  - site_name: Name of the site (e.g., "JAC Machines")
  - site_url: Production URL (e.g., "https://jac-machines.media")

Returns:
  - tables: all tables found with row counts and columns
  - suggested_collections: auto-detected content collections
  - i18n_detected: whether translation tables were found
  - contract: the generated Content Contract (saved if save=true)`,
      inputSchema: {
        save: z.boolean().default(false).describe('Save the generated contract to sm_globals'),
        site_name: z.string().min(1).describe('Site name (e.g., "JAC Machines")'),
        site_url: z.string().url().describe('Production URL'),
        stack: z.string().default('react-vite').describe('Tech stack: react-vite, next, astro, static'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ save, site_name, site_url, stack }) => {
      return withAudit('sm_discover', 'discover', context.getActiveTargetName(), {
        params: { site_name, site_url, save },
      }, async () => {
        const client = context.getClient();

        // 1. Introspect all tables
        const { data: tablesData, error: tablesError } = await client.rpc('exec_sql', {
          query: `
            SELECT 
              t.table_name,
              (SELECT reltuples::bigint FROM pg_class WHERE relname = t.table_name) as approx_rows
            FROM information_schema.tables t
            WHERE t.table_schema = 'public'
              AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name
          `
        });

        // Fallback if exec_sql not available
        let tableNames: string[] = [];
        let tableRows: Record<string, number> = {};

        if (tablesError) {
          // Use information_schema directly
          const { data } = await client
            .from('information_schema.tables' as unknown as string)
            .select('table_name')
            .eq('table_schema', 'public')
            .eq('table_type', 'BASE TABLE');
          tableNames = ((data || []) as unknown as { table_name: string }[]).map(t => t.table_name);
        } else if (tablesData) {
          const rows = typeof tablesData === 'string' ? JSON.parse(tablesData) : tablesData;
          for (const row of rows) {
            tableNames.push(row.table_name);
            tableRows[row.table_name] = row.approx_rows || 0;
          }
        }

        // 2. Get columns for each table
        const tables: TableInfo[] = [];
        const smTables: string[] = [];
        const skipPrefixes = ['sm_', 'auth.', '_', 'pg_', 'supabase_'];
        const systemTables = new Set([
          'schema_migrations', 'extensions', 'buckets', 'objects',
          'secrets', 'hooks', 'mfa_factors', 'sessions',
          'refresh_tokens', 'instances', 'flow_state',
          'saml_relay_states', 'sso_providers', 'sso_domains',
          'audit_log_entries', 'identities', 'one_time_tokens',
        ]);

        for (const tableName of tableNames) {
          // Track sm_ tables separately
          if (tableName.startsWith('sm_')) {
            smTables.push(tableName);
            continue;
          }

          // Skip system tables
          if (systemTables.has(tableName)) continue;
          if (skipPrefixes.some(p => tableName.startsWith(p))) continue;

          // Get column info
          const { data: colData } = await client.rpc('exec_sql', {
            query: `
              SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = '${tableName}'
              ORDER BY ordinal_position
            `
          });

          let columns: ColumnInfo[] = [];
          if (colData) {
            const cols = typeof colData === 'string' ? JSON.parse(colData) : colData;
            columns = cols.map((c: Record<string, string>) => ({
              name: c.column_name,
              type: c.data_type,
              nullable: c.is_nullable === 'YES',
              default_value: c.column_default,
            }));
          }

          // Detect if this is a translation table
          const hasLocaleColumn = columns.some(c => 
            c.name === 'locale' || c.name === 'language' || c.name === 'lang' || c.name === 'language_code'
          );
          const hasForeignKey = columns.some(c => c.name.endsWith('_id') && !c.name.startsWith('id'));

          tables.push({
            name: tableName,
            row_count: tableRows[tableName] || 0,
            columns,
            has_translations: hasLocaleColumn && hasForeignKey,
          });
        }

        // 3. Detect collections vs translation tables
        const translationTables = tables.filter(t => t.has_translations);
        const translationTableNames = new Set(translationTables.map(t => t.name));

        const suggestedCollections: SuggestedCollection[] = [];
        for (const table of tables) {
          if (translationTableNames.has(table.name)) continue; // Skip translation tables
          
          // Find matching translation table
          const possibleTranslationNames = [
            `${table.name}_translations`,
            `${table.name}_translation`,
            `${table.name}_i18n`,
            `${table.name}_locales`,
          ];
          const translationTable = translationTables.find(t => 
            possibleTranslationNames.includes(t.name)
          );

          // Detect slug field
          const slugField = table.columns.find(c => 
            c.name === 'slug' || c.name === 'url_slug' || c.name === 'permalink'
          );

          // Detect display field
          const displayField = table.columns.find(c =>
            c.name === 'name' || c.name === 'title' || c.name === 'label'
          );

          suggestedCollections.push({
            table: table.name,
            name: table.name.replace(/_/g, ' '),
            slug_field: slugField?.name,
            display_field: displayField?.name,
            translation_table: translationTable?.name,
            field_count: table.columns.length,
            row_count: tableRows[table.name] || 0,
          });
        }

        // 4. Detect i18n
        const i18nDetected = translationTables.length > 0;
        let detectedLocales: string[] = ['fr'];
        if (i18nDetected && translationTables.length > 0) {
          const localeCol = translationTables[0].columns.find(c => 
            c.name === 'locale' || c.name === 'language' || c.name === 'lang'
          );
          if (localeCol) {
            const { data: localeData } = await client
              .from(translationTables[0].name)
              .select(localeCol.name)
              .limit(100);
            if (localeData) {
              const locales = [...new Set((localeData as unknown as Record<string, string>[]).map(d => d[localeCol.name]))];
              if (locales.length > 0) detectedLocales = locales as string[];
            }
          }
        }

        // 5. Generate Content Contract
        const contract: ContentContract = {
          version: '1.0',
          generated_by: 'sm_discover',
          generated_at: new Date().toISOString(),
          site: {
            name: site_name,
            url: site_url,
            stack,
            onboarding_mode: 'existing_supabase',
          },
          content_mode: 'supabase',
          backend: {
            supabase: {
              project_ref: context.getActiveTargetConfig()?.supabase_url?.split('//')[1]?.split('.')[0] || '',
              url: context.getActiveTargetConfig()?.supabase_url || '',
            },
          },
          collections: {},
          globals: {
            site_config: {
              description: 'Company information',
              fields: {
                company_name: { type: 'string', required: true },
                phone: { type: 'string' },
                email: { type: 'string', format: 'email' },
                address: { type: 'object' },
                social: { type: 'object' },
              },
            },
            seo_config: {
              description: 'Global SEO settings',
              fields: {
                default_title_suffix: { type: 'string' },
                default_og_image: { type: 'string', format: 'url' },
                ga_measurement_id: { type: 'string' },
              },
            },
            navigation: {
              description: 'Site navigation',
              fields: {
                main_menu: { type: 'array' },
                footer_menu: { type: 'array' },
              },
            },
          },
          i18n: {
            enabled: i18nDetected,
            default_locale: detectedLocales[0] || 'fr',
            locales: detectedLocales,
            strategy: i18nDetected ? 'translation_table' : 'column',
            seo_sync: true,
          },
          seo: {
            score_threshold: 50,
            auto_sitemap: true,
            auto_schema: true,
          },
        };

        // Map suggested collections to contract
        for (const sc of suggestedCollections) {
          const table = tables.find(t => t.name === sc.table);
          if (!table) continue;

          const fields: Record<string, FieldConfig> = {};
          for (const col of table.columns) {
            if (['id', 'created_at', 'updated_at'].includes(col.name)) continue;

            fields[col.name] = {
              type: mapPostgresType(col.type) as FieldConfig['type'],
              required: !col.nullable && !col.default_value,
              translatable: false,
              description: col.name.replace(/_/g, ' '),
            };
          }

          contract.collections[sc.table] = {
            table: sc.table,
            slug_field: sc.slug_field || 'id',
            display_field: sc.display_field,
            translation_table: sc.translation_table,
            translation_key: sc.translation_table ? `${sc.table.replace(/s$/, '')}_id` : undefined,
            fields,
          };
        }

        // 6. Save if requested
        if (save) {
          await context.saveContract(contract);
        }

        const discoveryResult: DiscoveryResult = {
          project_ref: contract.backend.supabase?.project_ref || '',
          tables: tables.map(t => ({
            name: t.name,
            row_count: t.row_count,
            columns: t.columns,
            has_translations: t.has_translations,
          })),
          suggested_collections: suggestedCollections,
          suggested_globals: ['site_config', 'seo_config', 'navigation'],
          i18n_detected: i18nDetected,
          locales: detectedLocales,
          existing_sm_tables: smTables,
        };

        const output = {
          discovery: discoveryResult,
          contract,
          saved: save,
          message: save
            ? `Content Contract saved to sm_globals. ${suggestedCollections.length} collections detected, ${detectedLocales.length} locales.`
            : `Dry run complete. ${suggestedCollections.length} collections detected. Set save=true to persist the Content Contract.`,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_set_target
  // ----------------------------------------------------------
  server.registerTool(
    'sm_set_target',
    {
      title: 'Set Active Target',
      description: `Switch the active site in multi-target mode. All subsequent tool calls will operate on this site.

Args:
  - target: Name of the target site (e.g., "jac-machines", "wallfin")

Returns:
  - active target name and available targets`,
      inputSchema: {
        target: z.string().min(1).describe('Target site name from the configured targets'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target }) => {
      return withAudit('sm_set_target', 'switch', target, { params: { target } }, async () => {
        context.setTarget(target);
        
        // Try to load the contract for the new target
        const contract = await context.loadContract();

        const output = {
          active: target,
          available: context.getTargetNames(),
          contract_loaded: !!contract,
          site_name: contract?.site?.name || 'No contract — run sm_discover to generate one',
          site_url: contract?.site?.url || '',
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );

  // ----------------------------------------------------------
  // sm_get_site_options
  // ----------------------------------------------------------
  server.registerTool(
    'sm_get_site_options',
    {
      title: 'Get Site Options',
      description: `Read site globals: company config, SEO config, navigation, or any custom global.

Args:
  - key: Global key to read. Options: "site_config", "seo_config", "navigation", or any custom key.
         Use "*" to get all globals.

Returns:
  - The global data as JSON`,
      inputSchema: {
        key: z.string().min(1).describe('Global key: site_config, seo_config, navigation, or * for all'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key }) => {
      return withAudit('sm_get_site_options', 'read', context.getActiveTargetName(), {
        params: { key },
      }, async () => {
        const client = context.getClient();

        if (key === '*') {
          // Get all globals (except _content_contract)
          const { data, error } = await client
            .from('sm_globals')
            .select('key, data')
            .neq('key', '_content_contract');

          if (error) throw new Error(`Failed to read globals: ${error.message}`);

          const output: Record<string, unknown> = {};
          for (const row of data || []) {
            output[row.key] = row.data;
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        // Get specific global
        const { data, error } = await client
          .from('sm_globals')
          .select('data')
          .eq('key', key)
          .single();

        if (error) throw new Error(`Global "${key}" not found. Available keys: site_config, seo_config, navigation`);

        const output = { key, data: data.data };
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      });
    }
  );
}

// ============================================================
// Helpers
// ============================================================

function mapPostgresType(pgType: string): string {
  const mapping: Record<string, string> = {
    'text': 'string',
    'character varying': 'string',
    'varchar': 'string',
    'integer': 'number',
    'bigint': 'number',
    'smallint': 'number',
    'numeric': 'number',
    'real': 'number',
    'double precision': 'number',
    'boolean': 'boolean',
    'jsonb': 'json',
    'json': 'json',
    'timestamp with time zone': 'date',
    'timestamp without time zone': 'date',
    'date': 'date',
    'uuid': 'string',
    'ARRAY': 'array',
    'USER-DEFINED': 'string',
  };
  return mapping[pgType] || 'string';
}
