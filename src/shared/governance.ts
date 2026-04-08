/**
 * Governance — Enterprise execution controls
 * 
 * Same philosophy as WordPress MCP:
 * All restrictions enforced BEFORE any API call.
 */

import type { GovernanceConfig, AuditEntry } from '../types.js';

// ============================================================
// Load governance config from environment
// ============================================================

export function loadGovernanceConfig(): GovernanceConfig {
  return {
    readOnly: env('SM_READ_ONLY') === 'true',
    disableDelete: env('SM_DISABLE_DELETE') === 'true',
    confirmDeploy: env('SM_CONFIRM_DEPLOY') !== 'false', // default true
    auditLog: env('SM_AUDIT_LOG') !== 'off',             // default on
    contentMode: (env('SM_CONTENT_MODE') || 'supabase') as GovernanceConfig['contentMode'],
    deployTarget: (env('SM_DEPLOY_TARGET') || 'netlify') as GovernanceConfig['deployTarget'],
    maxCallsPerMinute: parseInt(env('SM_MAX_CALLS_PER_MINUTE') || '0') || 0,
    toolCategories: env('SM_TOOL_CATEGORIES') ? env('SM_TOOL_CATEGORIES')!.split(',').map(s => s.trim()) : [],
    compactJson: env('SM_COMPACT_JSON') !== 'false',     // default true
  };
}

// ============================================================
// Pre-flight governance enforcement
// ============================================================

const READ_ONLY_TOOLS = new Set([
  'sm_site_info', 'sm_discover', 'sm_set_target', 'sm_get_site_options',
  'sm_list_collections', 'sm_list_documents', 'sm_get_document', 'sm_search',
  'sm_get_navigation',
  'sm_get_seo_meta', 'sm_audit_seo', 'sm_check_rendering', 'sm_audit_links',
  'sm_suggest_internal_links', 'sm_seo_report',
  'sm_suggest_keywords', 'sm_growth_priorities', 'sm_growth_report',
  'sm_translation_coverage', 'sm_missing_translations',
  'sm_audit_performance', 'sm_audit_bundle', 'sm_audit_images',
  'sm_check_headers', 'sm_performance_report',
  'sm_deploy_status',
  'sm_get_analytics', 'sm_list_form_submissions',
  'sm_list_languages', 'sm_audit_translation_coverage', 'sm_get_translations',
  'sm_changelog',
]);

const DELETE_TOOLS = new Set([
  'sm_delete_document',
]);

const DEPLOY_TOOLS = new Set([
  'sm_deploy_production',
]);

export function enforceGovernance(tool: string, governance: GovernanceConfig): void {
  // Read-only mode blocks all write tools
  if (governance.readOnly && !READ_ONLY_TOOLS.has(tool)) {
    throw new GovernanceError(
      `Blocked: READ-ONLY mode active. Tool "${tool}" requires write access. ` +
      `Set SM_READ_ONLY=false to allow writes.`
    );
  }

  // Disable delete blocks delete tools
  if (governance.disableDelete && DELETE_TOOLS.has(tool)) {
    throw new GovernanceError(
      `Blocked: DELETE operations disabled. Tool "${tool}" requires delete permission. ` +
      `Set SM_DISABLE_DELETE=false to allow deletions.`
    );
  }

  // Confirm deploy blocks production deploys (handled in the tool itself via confirmation token)
  // We just flag it here for audit
}

export function isReadOnlyTool(tool: string): boolean {
  return READ_ONLY_TOOLS.has(tool);
}

export function requiresDeployConfirmation(tool: string, governance: GovernanceConfig): boolean {
  return governance.confirmDeploy && DEPLOY_TOOLS.has(tool);
}

// ============================================================
// Tool category filtering
// ============================================================

const TOOL_CATEGORIES: Record<string, string[]> = {
  core: ['sm_site_info', 'sm_discover', 'sm_set_target', 'sm_get_site_options'],
  content: [
    'sm_list_collections', 'sm_list_documents', 'sm_get_document',
    'sm_create_document', 'sm_update_document', 'sm_delete_document',
    'sm_update_global', 'sm_search', 'sm_get_navigation', 'sm_update_navigation',
    'sm_batch_update',
  ],
  seo: [
    'sm_get_seo_meta', 'sm_update_seo_meta', 'sm_audit_seo',
    'sm_check_rendering', 'sm_generate_schema', 'sm_inject_schema',
    'sm_generate_sitemap', 'sm_audit_links', 'sm_suggest_internal_links',
    'sm_seo_report',
  ],
  performance: [
    'sm_audit_performance', 'sm_audit_bundle', 'sm_audit_images',
    'sm_check_headers', 'sm_performance_report',
  ],
  deploy: [
    'sm_deploy_preview', 'sm_deploy_production', 'sm_deploy_status', 'sm_deploy_rollback',
  ],
  connect: [
    'sm_get_analytics', 'sm_list_form_submissions', 'sm_generate_social_post',
    'sm_sync_business_profile', 'sm_manage_webhooks',
  ],
  intelligence: [
    'sm_suggest_keywords', 'sm_growth_priorities', 'sm_growth_report',
  ],
  i18n: [
    'sm_translation_coverage', 'sm_missing_translations', 'sm_sync_seo_locales',
  ],
  governance: ['sm_changelog', 'sm_audit_log_query'],
};

export function getFilteredTools(categories: string[]): Set<string> {
  if (categories.length === 0) {
    // No filter = all tools
    return new Set(Object.values(TOOL_CATEGORIES).flat());
  }

  const tools = new Set<string>();
  // Core is always included
  for (const tool of TOOL_CATEGORIES.core) {
    tools.add(tool);
  }
  for (const cat of categories) {
    const catTools = TOOL_CATEGORIES[cat];
    if (catTools) {
      for (const tool of catTools) {
        tools.add(tool);
      }
    }
  }
  return tools;
}

// ============================================================
// Rate limiting
// ============================================================

const callTimestamps: number[] = [];

export function enforceRateLimit(maxPerMinute: number): void {
  if (maxPerMinute <= 0) return;

  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Remove old timestamps
  while (callTimestamps.length > 0 && callTimestamps[0] < oneMinuteAgo) {
    callTimestamps.shift();
  }

  if (callTimestamps.length >= maxPerMinute) {
    throw new GovernanceError(
      `Rate limit exceeded: ${maxPerMinute} calls/minute. ` +
      `Wait ${Math.ceil((callTimestamps[0] + 60_000 - now) / 1000)}s or increase SM_MAX_CALLS_PER_MINUTE.`
    );
  }

  callTimestamps.push(now);
}

// ============================================================
// Governance error
// ============================================================

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

// ============================================================
// Helpers
// ============================================================

function env(key: string): string | undefined {
  return process.env[key];
}
