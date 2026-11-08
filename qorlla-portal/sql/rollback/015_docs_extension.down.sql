-- Reverses 015_docs_extension.sql. DESTROYS folders, stars, template flags and comments (documents and their versions are not touched). Back up first.
BEGIN;
DROP TABLE IF EXISTS portal.doc_comments;
DROP TABLE IF EXISTS portal.doc_stars;
DROP TABLE IF EXISTS portal.doc_metadata;
DROP TABLE IF EXISTS portal.doc_folders;
COMMIT;
