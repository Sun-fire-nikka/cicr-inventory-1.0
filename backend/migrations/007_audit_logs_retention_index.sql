-- Migration 007: Composite Index & Retention Optimization for audit_logs
-- Accelerates 7-day range queries and automated retention pruning

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_desc
  ON public.audit_logs ("timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_action
  ON public.audit_logs ("timestamp" DESC, action);

-- Optional database function for manual/cron cleanup if run directly in Postgres
CREATE OR REPLACE FUNCTION purge_expired_audit_logs(retention_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.audit_logs
  WHERE "timestamp" < (NOW() - (retention_days || ' days')::interval);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
