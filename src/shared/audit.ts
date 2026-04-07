/**
 * Audit — Structured JSON audit trail
 * 
 * Dual output:
 * 1. stderr (JSON stream) — for log pipelines (Datadog, Splunk, ELK)
 * 2. sm_audit_log table — for persistence and queryability
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry } from '../types.js';

let auditEnabled = true;
let supabaseClient: SupabaseClient | null = null;

export function configureAudit(enabled: boolean, client?: SupabaseClient): void {
  auditEnabled = enabled;
  supabaseClient = client || null;
}

export async function logAudit(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
  const fullEntry: AuditEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  // 1. Always write to stderr (JSON line)
  if (auditEnabled) {
    process.stderr.write(JSON.stringify(fullEntry) + '\n');
  }

  // 2. Persist to Supabase if available
  if (supabaseClient) {
    try {
      await supabaseClient.from('sm_audit_log').insert({
        timestamp: fullEntry.timestamp,
        tool: fullEntry.tool,
        action: fullEntry.action,
        site: fullEntry.site,
        collection: fullEntry.collection,
        document_id: fullEntry.document_id,
        document_slug: fullEntry.document_slug,
        status: fullEntry.status,
        latency_ms: fullEntry.latency_ms,
        params: fullEntry.params || {},
        changes: fullEntry.changes || {},
        error: fullEntry.error,
      });
    } catch {
      // Audit persistence failure should not break the tool
      process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        tool: '_audit_persist',
        action: 'write',
        status: 'error',
        error: 'Failed to persist audit log to Supabase',
        site: fullEntry.site,
        latency_ms: 0,
      }) + '\n');
    }
  }
}

/**
 * Wraps a tool handler with audit logging and timing.
 */
export async function withAudit<T>(
  tool: string,
  action: string,
  site: string,
  meta: { collection?: string; document_id?: string; document_slug?: string; params?: Record<string, unknown>; changes?: Record<string, unknown> },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await logAudit({
      tool,
      action,
      site,
      collection: meta.collection,
      document_id: meta.document_id,
      document_slug: meta.document_slug,
      status: 'success',
      latency_ms: Date.now() - start,
      params: meta.params,
    });
    return result;
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logAudit({
      tool,
      action,
      site,
      collection: meta.collection,
      document_id: meta.document_id,
      document_slug: meta.document_slug,
      status: 'error',
      latency_ms: Date.now() - start,
      params: meta.params,
      error: errorMsg,
    });
    throw error;
  }
}
