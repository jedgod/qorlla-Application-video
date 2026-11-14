-- Reverses 017_portal_chat.sql. DESTRUCTIVE: every Portal Chat conversation, message, version, pin, bookmark, task, AI-request record and chat audit row is deleted.
-- Nothing else is touched (the main-app JSON chat, Meet chat, workspaces, members, plans and every other entitlement stay as they are).
-- Take a backup first if the chat data matters. Roll the application code back first or together: the chat routes fail (500) without these tables.
BEGIN;
DROP TRIGGER IF EXISTS chat_audit_no_change ON portal.chat_audit;
DROP TABLE IF EXISTS portal.chat_audit;
DROP FUNCTION IF EXISTS portal.chat_audit_immutable();
DROP TABLE IF EXISTS portal.chat_ai_requests;
DROP TABLE IF EXISTS portal.chat_tasks;
DROP TABLE IF EXISTS portal.chat_bookmarks;
DROP TABLE IF EXISTS portal.chat_pins;
DROP TABLE IF EXISTS portal.chat_events;
DROP TABLE IF EXISTS portal.chat_message_versions;
DROP TABLE IF EXISTS portal.chat_messages;
DROP TABLE IF EXISTS portal.chat_members;
DROP TABLE IF EXISTS portal.chat_conversations;
DELETE FROM portal.entitlements WHERE feature IN ('chat', 'chat.channels.max', 'chat.ai');
COMMIT;
