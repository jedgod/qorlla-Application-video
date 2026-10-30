-- Rolls back 008 (enterprise operations). DATA LOSS: drops staff, tickets, messages, workforce, ops refund requests, outbox, audit and request tables.
-- It does NOT touch portal.invoices, portal.refund_requests or portal.refunds (the billing authority): money already moved stays recorded there. Take a backup first. Idempotent.
DROP TABLE IF EXISTS portal.ops_external_call_requests, portal.ops_number_requests, portal.ops_audit_log, portal.ops_outbox, portal.ops_refund_requests,
  portal.ops_leave_requests, portal.ops_time_entries, portal.ops_shifts, portal.ops_ticket_messages, portal.ops_ticket_events, portal.ops_tickets, portal.ops_staff CASCADE;
DROP FUNCTION IF EXISTS portal.ops_refund_guard();
DROP FUNCTION IF EXISTS portal.ops_append_only();
