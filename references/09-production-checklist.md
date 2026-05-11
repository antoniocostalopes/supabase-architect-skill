# Production Readiness — Supabase

Checklist completa para validar antes de servir tráfego real em produção.

## A. Security (bloqueante)

### A1. RLS coverage
- [ ] Todas as tabelas em `public.*` com dados de utilizador têm `rowsecurity = true`
- [ ] Tabelas com RLS têm policies (sem policies = nega tudo, geralmente erro)
- [ ] Nenhuma policy `USING (true)` salvo em tabela genuinamente pública
- [ ] Policies multi-tenant filtram por `organization_id` via helper
- [ ] `WITH CHECK` definido em INSERT/UPDATE para validar novo estado
- [ ] `auth.role() = 'authenticated'` NÃO é usado como única condição

### A2. service_role isolation
- [ ] `SUPABASE_SERVICE_ROLE_KEY` não tem prefixo público (`NEXT_PUBLIC_`, `VITE_`, etc.)
- [ ] Search no código por `SERVICE_ROLE` no client bundle vem vazio
- [ ] Edge Functions e route handlers que usam service_role validam auth do user antes
- [ ] Repositório não tem secret commitado (verificar git history)

### A3. Storage
- [ ] Nenhum bucket público com conteúdo sensível (PII, faturas, contratos)
- [ ] Buckets privados têm policies SELECT/INSERT/UPDATE/DELETE
- [ ] Path strategy isola por tenant: `<org_id>/<user_id>/...`
- [ ] `file_size_limit` configurado por bucket
- [ ] `allowed_mime_types` configurado onde aplicável
- [ ] Signed URLs usam TTL curto (segundos a minutos)

### A4. Auth configuration
- [ ] Email confirmation ATIVA em produção
- [ ] Site URL configurada (sem `localhost`)
- [ ] Redirect URLs lista exaustiva, sem wildcards perigosos
- [ ] Refresh Token Rotation ATIVA
- [ ] Refresh Token Reuse Detection ATIVA
- [ ] JWT Expiry razoável (3600s default)
- [ ] Password requirements: min 12 chars + pwned check
- [ ] Rate limits aceitáveis (sign-up, sign-in, OTP, recover)
- [ ] OAuth providers usam apenas as scopes mínimas necessárias

### A5. Edge Functions
- [ ] Cada função valida `Authorization` header
- [ ] CORS limitado a domínios reais (não `*`)
- [ ] Inputs validados com schema (Zod/Valibot)
- [ ] Webhooks validam signature do provider
- [ ] Logs não contêm secrets ou PII desnecessária

### A6. Functions SECURITY DEFINER
- [ ] Todas as funções `SECURITY DEFINER` têm `SET search_path = ...` fixado
- [ ] `EXECUTE` revogado de `PUBLIC` e concedido só onde necessário
- [ ] Funções marcadas `STABLE`/`IMMUTABLE` quando apropriado

### A7. Grants
- [ ] `anon` role tem privilégios mínimos (revogar excesso)
- [ ] `authenticated` role tem privilégios apropriados ao esquema
- [ ] Tabelas internas não estão grantadas a `anon`/`authenticated`

## B. Performance

### B1. Indexes
- [ ] Toda FK tem index correspondente
- [ ] Tabelas multi-tenant têm index em `organization_id`
- [ ] Padrões de listing (org + created_at DESC) têm index composto
- [ ] Soft-delete: partial indexes `WHERE deleted_at IS NULL`
- [ ] Sem indexes duplicados/redundantes
- [ ] Indexes em produção foram criados com `CONCURRENTLY` (sem locks)

### B2. Queries
- [ ] Sem `SELECT *` em hot paths (selecionar colunas explícitas)
- [ ] Paginação keyset/cursor em listings grandes (não OFFSET)
- [ ] N+1 do cliente eliminado via embedding (`select('..., relacao(...)')`)
- [ ] RPCs `STABLE`/`SECURITY DEFINER` para dashboards de agregação

### B3. Realtime
- [ ] Só tabelas estritamente necessárias na publication `supabase_realtime`
- [ ] Subscriptions têm `filter` server-side
- [ ] Canais são por escopo (tenant/recurso), não globais
- [ ] `REPLICA IDENTITY FULL` só onde necessário (caro)
- [ ] Cleanup de subscriptions ao unmount

### B4. Connection pooling
- [ ] Serverless (Next.js API routes, Edge Functions externas) → transaction mode (`:6543`)
- [ ] Apps long-lived → session mode (`:5432`)
- [ ] `DATABASE_URL` correto para o modo do runtime

## C. Migrations & schema

### C1. Versioning
- [ ] Todas as migrações em `supabase/migrations/` versionadas em git
- [ ] Sem drift entre Studio e migrations (`supabase db diff` limpo)
- [ ] Migrações testadas em ambiente local (`supabase db reset`)
- [ ] Migrações testadas em staging antes de produção

### C2. Safety
- [ ] Nenhuma migração com `DROP TABLE`/`DROP COLUMN` sem aprovação documentada
- [ ] Backfills em batches, não em UPDATE direto
- [ ] `ALTER ... NOT NULL` tem `DEFAULT` constante ou faz expand/contract
- [ ] `CREATE INDEX` em tabela grande usa `CONCURRENTLY`
- [ ] Cada migração não-trivial tem `.down.sql` ou documentação de rollback

## D. Data integrity

- [ ] FKs apropriadas com `ON DELETE CASCADE`/`SET NULL` conforme semântica
- [ ] CHECK constraints onde aplicável (`amount > 0`, `email LIKE '%@%'`, etc.)
- [ ] UNIQUE constraints onde aplicável (e por-tenant onde for o caso)
- [ ] Enums para vocabulário fechado (status, role, etc.)
- [ ] `created_at` / `updated_at` automáticos via trigger
- [ ] Soft-delete (`deleted_at`) consistentemente filtrado em policies/queries
- [ ] `tenant_id` immutable (trigger ou WITH CHECK)

## E. Observability

### E1. Logging
- [ ] Logs estruturados em Edge Functions
- [ ] Erros não vazam stack trace para o cliente
- [ ] Auditoria de operações críticas (delete, role change, etc.) numa tabela `audit_logs`

### E2. Monitoring
- [ ] Dashboard Supabase: alertas para CPU, IOPS, conexões
- [ ] Métricas de erros 5xx em Edge Functions
- [ ] Métricas de latência de queries (Supabase Reports)

### E3. Health checks
- [ ] Endpoint público `/health` na app que verifica DB conectividade
- [ ] Probe de DB básico (`SELECT 1`)

## F. Backups e disaster recovery

- [ ] Plano Supabase com backups automatizados ativo (PITR se possível)
- [ ] Restore foi testado pelo menos uma vez (não confiar que "deve funcionar")
- [ ] Exports manuais em S3/storage frio para dados críticos (defense in depth)
- [ ] Documentação de RTO/RPO (Recovery Time/Point Objective) escrita

## G. Environment hygiene

- [ ] `.env.example` no repo com todas as vars necessárias (sem valores reais)
- [ ] `.env.local` e variantes no `.gitignore`
- [ ] Dev/staging/prod usam projetos Supabase separados (não a mesma DB)
- [ ] Service role keys rotadas se já foram acidentalmente expostas
- [ ] Credenciais OAuth providers diferentes por ambiente

## H. App-level

### H1. Cliente
- [ ] Cliente cria cliente Supabase apenas com `anon` key
- [ ] SSR usa `@supabase/ssr` com `getUser()` (não `getSession()`)
- [ ] Middleware refresca sessão em apps SSR
- [ ] CSP/headers de segurança configurados na app

### H2. Domain rules
- [ ] Operações de admin têm UI separada
- [ ] Erros de RLS no cliente mostram mensagem amigável (não revelar detalhes)
- [ ] Cliente revalida dados após operações sensíveis (não confiar apenas em realtime)

## I. Rate limiting & abuse

- [ ] Auth endpoints rate-limited no Supabase Auth
- [ ] Endpoints custom (Edge Functions) rate-limited (per IP / per user)
- [ ] Resource-intensive RPCs rate-limited
- [ ] CAPTCHA em sign-up / recover se exposto sem invite-only

## J. Compliance & privacy

- [ ] GDPR: existe processo para `export user data` e `delete user data`
- [ ] Logs/audit que contêm PII têm retention policy definida
- [ ] DPA assinada com Supabase (se aplicável)
- [ ] Region da DB respeita requisitos de residência de dados

## K. Documentation

- [ ] `README.md` da DB descreve estrutura, decisões, padrões
- [ ] `SUPABASE_ARCHITECTURE.md` em `docs/`
- [ ] `SUPABASE_RLS.md` em `docs/`
- [ ] Runbook para incidentes (DB down, RLS escapada, key comprometida)
- [ ] Decisões arquiteturais (ADRs) em `docs/decisions/`

## Queries de auditoria automatizada

Correr no Supabase SQL Editor antes de aprovar produção:

```sql
-- 1. RLS coverage gap
SELECT schemaname || '.' || tablename AS missing_rls
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false
ORDER BY tablename;

-- 2. RLS true mas sem policies
SELECT t.schemaname || '.' || t.tablename AS rls_no_policies
FROM pg_tables t
LEFT JOIN pg_policies p USING (schemaname, tablename)
WHERE t.schemaname = 'public' AND t.rowsecurity = true AND p.policyname IS NULL;

-- 3. FK sem index
SELECT
  c.conrelid::regclass AS table_name,
  a.attname AS fk_column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND a.attnum = i.indkey[0]
  )
ORDER BY table_name;

-- 4. SECURITY DEFINER sem search_path
SELECT n.nspname || '.' || p.proname AS function_name
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef = true
  AND n.nspname IN ('public','auth')
  AND NOT EXISTS (
    SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
  );

-- 5. Indexes nunca usados (>30 dias de stats)
SELECT
  schemaname, relname, indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE idx_scan = 0 AND NOT indisunique AND schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- 6. Buckets públicos
SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE public = true;

-- 7. Privilégios excessivos em anon
SELECT table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'anon' AND table_schema = 'public';

-- 8. Tabelas em realtime
SELECT schemaname || '.' || tablename
FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

## Sign-off

Produção pronta quando:

1. Todas as secções A (Security) estão `[x]`
2. Pelo menos 90% das outras secções estão `[x]`
3. Quaisquer itens `[ ]` restantes estão documentados com justificativa e plano
4. Owner técnico assinou o checklist
