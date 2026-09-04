-- P0.2 — complete, stable schema snapshot for before/after diffing.
-- Emits one normalised line per object so `diff` is meaningful.
\pset pager off
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

-- INDEXES (includes partial, functional and expression indexes via indexdef)
SELECT 'INDEX|' || schemaname || '.' || indexname || '|' || regexp_replace(indexdef, '\s+', ' ', 'g')
  FROM pg_indexes
 WHERE schemaname = 'public'
 ORDER BY indexname;

-- CONSTRAINTS: p=primary u=unique f=foreign c=check x=exclusion t=trigger
SELECT 'CONSTRAINT|' || c.contype::text || '|' || t.relname || '.' || c.conname || '|'
       || regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY t.relname, c.conname;

-- TRIGGERS (user triggers only; FK-enforcement triggers are internal)
SELECT 'TRIGGER|' || c.relname || '.' || tg.tgname || '|'
       || regexp_replace(pg_get_triggerdef(tg.oid), '\s+', ' ', 'g')
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT tg.tgisinternal AND n.nspname = 'public'
 ORDER BY c.relname, tg.tgname;

-- EXTENSIONS
SELECT 'EXTENSION|' || extname || '|' || extversion
  FROM pg_extension ORDER BY extname;

-- FUNCTIONS
SELECT 'FUNCTION|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' ORDER BY p.proname;

-- TABLES
SELECT 'TABLE|' || tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;

-- COLUMN DEFAULTS + NOT NULL (catches ALTER COLUMN drift)
SELECT 'COLUMN|' || table_name || '.' || column_name || '|' || data_type
       || '|null=' || is_nullable || '|def=' || COALESCE(column_default, '-')
  FROM information_schema.columns
 WHERE table_schema = 'public'
 ORDER BY table_name, column_name;
