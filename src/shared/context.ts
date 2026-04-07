/**
 * Context — Active site connection and Content Contract
 * 
 * Manages the current target site, Supabase client,
 * and Content Contract. Equivalent to the WP MCP
 * target management system.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ContentContract, TargetConfig } from '../types.js';

// ============================================================
// State
// ============================================================

let activeTarget: string | null = null;
let activeClient: SupabaseClient | null = null;
let activeContract: ContentContract | null = null;
let targets: Record<string, TargetConfig> = {};

// ============================================================
// Target management
// ============================================================

/**
 * Load targets from environment (single site or multi-target)
 */
export function loadTargets(): void {
  const targetsJson = process.env.SM_TARGETS_JSON;
  const targetsFile = process.env.SM_TARGETS_FILE;

  if (targetsJson) {
    targets = JSON.parse(targetsJson);
  } else if (targetsFile) {
    // Dynamic import would be used in real implementation
    // For now, we expect SM_TARGETS_JSON
    process.stderr.write('[sm] SM_TARGETS_FILE not yet implemented, use SM_TARGETS_JSON\n');
  } else {
    // Single site mode — construct from individual env vars
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const siteUrl = process.env.SITE_URL || '';

    if (url && key) {
      targets.default = {
        supabase_url: url,
        supabase_service_key: key,
        site_url: siteUrl,
        deploy_provider: (process.env.SM_DEPLOY_TARGET as TargetConfig['deploy_provider']) || 'netlify',
        netlify_token: process.env.NETLIFY_TOKEN,
        netlify_site_id: process.env.NETLIFY_SITE_ID,
      };
    }
  }

  // Auto-select if only one target
  const targetNames = Object.keys(targets);
  if (targetNames.length === 1) {
    setTarget(targetNames[0]);
  }
}

/**
 * Switch to a specific target site
 */
export function setTarget(name: string): void {
  const config = targets[name];
  if (!config) {
    const available = Object.keys(targets).join(', ');
    throw new Error(`Target "${name}" not found. Available: ${available || 'none'}`);
  }

  activeTarget = name;
  activeClient = createClient(config.supabase_url, config.supabase_service_key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  activeContract = null; // Will be lazy-loaded

  process.stderr.write(`[sm] Target set: ${name} → ${config.supabase_url}\n`);
}

/**
 * Get the active Supabase client
 */
export function getClient(): SupabaseClient {
  if (!activeClient) {
    throw new Error('No active target. Call sm_set_target first, or configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  }
  return activeClient;
}

/**
 * Get the active target name
 */
export function getActiveTargetName(): string {
  return activeTarget || 'none';
}

/**
 * Get the active target config
 */
export function getActiveTargetConfig(): TargetConfig | null {
  if (!activeTarget) return null;
  return targets[activeTarget] || null;
}

/**
 * Get all target names
 */
export function getTargetNames(): string[] {
  return Object.keys(targets);
}

// ============================================================
// Content Contract management
// ============================================================

/**
 * Load the Content Contract from sm_globals
 */
export async function loadContract(): Promise<ContentContract | null> {
  if (activeContract) return activeContract;

  const client = getClient();
  const { data, error } = await client
    .from('sm_globals')
    .select('data')
    .eq('key', '_content_contract')
    .single();

  if (error || !data || !data.data || Object.keys(data.data).length === 0) {
    return null;
  }

  activeContract = data.data as ContentContract;
  return activeContract;
}

/**
 * Save the Content Contract to sm_globals
 */
export async function saveContract(contract: ContentContract): Promise<void> {
  const client = getClient();
  const { error } = await client
    .from('sm_globals')
    .upsert({
      key: '_content_contract',
      data: contract,
    }, { onConflict: 'key' });

  if (error) {
    throw new Error(`Failed to save Content Contract: ${error.message}`);
  }

  activeContract = contract;
}

/**
 * Clear cached contract (force reload on next access)
 */
export function invalidateContract(): void {
  activeContract = null;
}
