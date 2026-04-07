/**
 * @adsim/site-manager-mcp-server — Type definitions
 */

// ============================================================
// Content Contract types
// ============================================================

export interface ContentContract {
  version: string;
  generated_by?: string;
  generated_at?: string;
  site: SiteConfig;
  content_mode: 'supabase' | 'files' | 'local';
  backend: BackendConfig;
  deploy?: DeployConfig;
  collections: Record<string, CollectionConfig>;
  globals: Record<string, GlobalConfig>;
  i18n?: I18nConfig;
  media?: MediaConfig;
  seo?: SeoConfig;
}

export interface SiteConfig {
  name: string;
  url: string;
  stack: string;
  framework?: string;
  onboarding_mode: 'new' | 'existing_supabase' | 'existing_files' | 'overlay';
  description?: string;
}

export interface BackendConfig {
  supabase?: {
    project_ref: string;
    url: string;
  };
  files?: {
    repo: string;
    branch: string;
    base_path: string;
    format: 'json' | 'markdown';
  };
}

export interface DeployConfig {
  provider: 'netlify' | 'vercel' | 'custom';
  site_id?: string;
  auto_deploy: boolean;
  production_branch?: string;
}

export interface CollectionConfig {
  table: string;
  slug_field: string;
  display_field?: string;
  translation_table?: string;
  translation_key?: string;
  translation_locale_field?: string;
  fields: Record<string, FieldConfig>;
}

export interface GlobalConfig {
  description?: string;
  fields: Record<string, FieldConfig>;
}

export interface FieldConfig {
  type: 'string' | 'number' | 'boolean' | 'richtext' | 'date' | 'json' | 'array' | 'object' | 'relation' | 'enum';
  required?: boolean;
  translatable?: boolean;
  default?: unknown;
  max?: number;
  format?: string;
  description?: string;
  target?: string;       // for relation type
  values?: string[];     // for enum type
  properties?: Record<string, FieldConfig>; // for object type
}

export interface I18nConfig {
  enabled: boolean;
  default_locale: string;
  locales: string[];
  strategy: 'translation_table' | 'suffix' | 'column';
  seo_sync: boolean;
}

export interface MediaConfig {
  storage: 'supabase_storage' | 'local' | 'cdn';
  bucket?: string;
  path?: string;
  max_size_kb: number;
  formats: string[];
  breakpoints?: number[];
}

export interface SeoConfig {
  score_threshold: number;
  auto_sitemap: boolean;
  auto_schema: boolean;
  default_schema_types?: Record<string, string[]>;
  gsc_property?: string;
}

// ============================================================
// Governance types
// ============================================================

export interface GovernanceConfig {
  readOnly: boolean;
  disableDelete: boolean;
  confirmDeploy: boolean;
  auditLog: boolean;
  contentMode: 'supabase' | 'files' | 'local' | 'auto';
  deployTarget: 'netlify' | 'vercel' | 'custom';
  maxCallsPerMinute: number;
  toolCategories: string[];
  compactJson: boolean;
}

// ============================================================
// Target (multi-site) types
// ============================================================

export interface TargetConfig {
  supabase_url: string;
  supabase_service_key: string;
  site_url: string;
  deploy_provider?: 'netlify' | 'vercel' | 'custom';
  netlify_token?: string;
  netlify_site_id?: string;
  vercel_token?: string;
  vercel_project_id?: string;
}

// ============================================================
// Audit log types
// ============================================================

export interface AuditEntry {
  timestamp: string;
  tool: string;
  action: string;
  site: string;
  collection?: string;
  document_id?: string;
  document_slug?: string;
  target_type?: string;
  status: 'success' | 'error' | 'blocked';
  latency_ms: number;
  params?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  error?: string;
}

// ============================================================
// SEO types
// ============================================================

export interface SeoMeta {
  id: string;
  page_type: string;
  page_id: string;
  locale: string;
  meta_title: string | null;
  meta_description: string | null;
  focus_keyword: string | null;
  canonical: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  noindex: boolean;
  nofollow: boolean;
  seo_score: number;
  score_details: Record<string, number>;
  last_audit: string | null;
}

export interface SeoScoreResult {
  score: number;
  details: Record<string, number>;
  checks: SeoCheck[];
}

export interface SeoCheck {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  penalty: number;
  message: string;
}

// ============================================================
// Document types
// ============================================================

export interface DocumentList {
  documents: Record<string, unknown>[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  status?: string;
  locale?: string;
  search?: string;
  filters?: Record<string, unknown>;
}

// ============================================================
// Discovery types
// ============================================================

export interface DiscoveryResult {
  project_ref: string;
  tables: TableInfo[];
  suggested_collections: SuggestedCollection[];
  suggested_globals: string[];
  i18n_detected: boolean;
  locales?: string[];
  existing_sm_tables: string[];
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: ColumnInfo[];
  has_translations: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
}

export interface SuggestedCollection {
  table: string;
  name: string;
  slug_field?: string;
  display_field?: string;
  translation_table?: string;
  field_count: number;
  row_count: number;
}
