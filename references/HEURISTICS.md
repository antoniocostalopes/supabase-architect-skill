# Heuristics Catalog — Supabase Architect

Catálogo central de **todas as heurísticas de detecção** codificadas pela skill. Fonte única para sinais que aparecem espalhados pelos `references/*.md`. Cada heurística tem ID, sinal técnico, severidade default e onde fica documentada em profundidade.

Razão de ser: evita drift entre references quando uma heurística é descrita em múltiplos sítios.

## Como usar

- **Na Fase 4** do workflow (Detecção de problemas críticos): correr o catálogo top-to-bottom.
- **Em outputs**: cita o ID da heurística (`H07`) para rastreabilidade.
- **Em CHANGELOG**: novas heurísticas têm ID novo (H21+), nunca renumerar.

## Convenção

- **ID**: `H<NN>` (sequencial)
- **Sinal**: regex/SQL/pattern observável
- **Severidade default**: pode ser elevada/baixada conforme contexto
- **Confidence default**: 95% (signal claro) | 80% (forte mas precisa contexto) | 60% (suspeita)
- **Deep dive**: link para reference que aprofunda
- **Anti-pattern relacionado**: V01–V20 de `10-common-vulnerabilities.md`

---

## RLS

### H01 — Tabela `public.*` sem RLS
- **Sinal SQL**:
  ```sql
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND rowsecurity = false;
  ```
- **Sinal código**: `CREATE TABLE public.X (...)` sem `ALTER TABLE X ENABLE ROW LEVEL SECURITY` subsequente
- **Severidade**: **Crítico** se tabela contém dados de utilizador; **Médio** se tabela de referência (countries, currencies)
- **Confidence**: 95%
- **Anti-pattern**: [V01](10-common-vulnerabilities.md#v01--tabela-sem-rls-cr%C3%ADtico)
- **Deep dive**: [`01-rls-patterns.md`](01-rls-patterns.md) § Fundamentos

### H02 — Policy `USING (true)` ou `WITH CHECK (true)`
- **Sinal SQL**:
  ```sql
  SELECT tablename, policyname FROM pg_policies
  WHERE schemaname = 'public' AND (qual = 'true' OR with_check = 'true');
  ```
- **Severidade**: **Crítico** salvo tabela pública (blog posts publicados, etc.)
- **Confidence**: 95%
- **Anti-pattern**: [V02](10-common-vulnerabilities.md#v02--policy-using-true-cr%C3%ADtico)
- **Deep dive**: [`01-rls-patterns.md`](01-rls-patterns.md) § Anti-patterns

### H03 — Policy sem filtro de tenant em sistema multi-tenant
- **Sinal**: tabela tem `organization_id` (ou tenant_id, workspace_id) mas a policy usa apenas `user_id = auth.uid()` ou `auth.role() = 'authenticated'`
- **Severidade**: **Alto**
- **Confidence**: 90%
- **Anti-pattern**: [V03](10-common-vulnerabilities.md#v03--policy-s%C3%B3-com-user_id-em-sistema-multi-tenant-alto)
- **Deep dive**: [`02-multi-tenant-patterns.md`](02-multi-tenant-patterns.md) § Helpers de autorização

### H04 — `auth.role() = 'authenticated'` como única condição
- **Sinal código**: `USING (auth.role() = 'authenticated')` ou `USING (auth.uid() IS NOT NULL)`
- **Severidade**: **Crítico** — equivalente a "logado = admin"
- **Confidence**: 95%
- **Deep dive**: [`01-rls-patterns.md`](01-rls-patterns.md) § Anti-patterns A2

### H05 — Subquery inline em policy (em vez de helper)
- **Sinal código**:
  ```sql
  USING (organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid()))
  ```
- **Severidade**: **Médio** (performance), pode ser **Alto** em volume
- **Confidence**: 80%
- **Fix**: usar helper `STABLE SECURITY DEFINER`
- **Deep dive**: [`03-postgresql-performance.md`](03-postgresql-performance.md) § RLS e performance

### H06 — Tabela com RLS ativa mas sem policies
- **Sinal SQL**:
  ```sql
  SELECT t.tablename FROM pg_tables t
  LEFT JOIN pg_policies p USING (schemaname, tablename)
  WHERE t.schemaname = 'public' AND t.rowsecurity = true AND p.policyname IS NULL;
  ```
- **Severidade**: **Médio** — significa "nega tudo a authenticated/anon". Pode ser intencional, mas valida.
- **Confidence**: 60%

---

## Auth / Secrets

### H07 — `service_role` exposto no cliente
- **Sinal grep**:
  ```
  NEXT_PUBLIC_.*SERVICE_ROLE
  VITE_.*SERVICE_ROLE
  PUBLIC_.*SERVICE_ROLE
  EXPO_PUBLIC_.*SERVICE_ROLE
  ```
- **Severidade**: **Crítico** — bypass total de RLS, acessível no browser
- **Confidence**: 95%
- **Anti-pattern**: [V04](10-common-vulnerabilities.md#v04--service_role-exposto-no-frontend-cr%C3%ADtico)
- **Deep dive**: [`05-auth-security.md`](05-auth-security.md) § Service role — regras absolutas

### H08 — `getSession()` em SSR sem revalidação
- **Sinal grep**: `getSession()` em middleware, route handler, server component
- **Severidade**: **Alto** — cookie forjável passa
- **Confidence**: 85%
- **Fix**: substituir por `getUser()`
- **Deep dive**: [`05-auth-security.md`](05-auth-security.md) § SSR pattern

### H09 — `SECURITY DEFINER` sem `search_path` fixo
- **Sinal SQL**:
  ```sql
  SELECT n.nspname || '.' || p.proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef = true AND n.nspname IN ('public','auth')
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'
    );
  ```
- **Severidade**: **Alto** — escalação de privilégios via schema hijacking
- **Confidence**: 90%
- **Anti-pattern**: [V13](10-common-vulnerabilities.md#v13--security-definer-em-fun%C3%A7%C3%A3o-sem-search_path-fixo-alto)

### H10 — `EXECUTE` em funções SECURITY DEFINER concedida a PUBLIC
- **Sinal SQL**:
  ```sql
  SELECT grantee, privilege_type, routine_name
  FROM information_schema.routine_privileges
  WHERE grantee = 'PUBLIC' AND privilege_type = 'EXECUTE';
  ```
- **Severidade**: **Alto** — exposição da função a anon
- **Confidence**: 90%

### H11 — Admins / owners sem MFA enrolled
- **Sinal SQL**:
  ```sql
  SELECT u.email, m.role FROM public.memberships m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN auth.mfa_factors f ON f.user_id = u.id AND f.status = 'verified'
  WHERE m.role IN ('owner','admin') AND m.is_active = true AND f.id IS NULL;
  ```
- **Severidade**: **Alto** em SaaS B2B; **Médio** em B2C
- **Confidence**: 95%
- **Deep dive**: [`05-auth-security.md`](05-auth-security.md) § MFA / TOTP

### H12 — Anonymous sign-ins activos sem CAPTCHA
- **Sinal**: feature ativa no Dashboard sem rate limit ou CAPTCHA
- **Severidade**: **Médio**
- **Confidence**: 70%
- **Deep dive**: [`05-auth-security.md`](05-auth-security.md) § Anonymous sign-ins

### H13 — SSO com `is_verified = false`
- **Sinal SQL**: linhas em `public.org_sso_domains` sem `is_verified`
- **Severidade**: **Alto** — provisioning automático para domínio não confirmado
- **Confidence**: 95%
- **Deep dive**: [`05-auth-security.md`](05-auth-security.md) § SSO / SAML

---

## Storage

### H14 — Bucket público com PII / dados de utilizador
- **Sinal SQL**:
  ```sql
  SELECT id, public FROM storage.buckets WHERE public = true;
  ```
- **Severidade**: **Crítico** se contém invoices, contratos, exports; **OK** para avatars públicos
- **Confidence**: depende do conteúdo (80-95%)
- **Anti-pattern**: [V05](10-common-vulnerabilities.md#v05--bucket-p%C3%BAblico-com-dados-privados-altocr%C3%ADtico)
- **Deep dive**: [`06-storage-security.md`](06-storage-security.md) § Public vs Private

### H15 — Bucket privado sem policies
- **Sinal SQL**:
  ```sql
  SELECT b.id FROM storage.buckets b
  WHERE b.public = false AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.tablename = 'objects' AND p.schemaname = 'storage'
      AND b.id::text = ANY(string_to_array(p.qual::text, ''''))
  );
  ```
- **Severidade**: **Médio** (bloqueia tudo) ou **Crítico** se há `USING (true)` em outra policy
- **Confidence**: 70%

### H16 — Path sem prefixo de tenant em multi-tenant
- **Sinal**: bucket onde `storage.foldername(name)[1]` não é UUID de organização
- **Severidade**: **Alto**
- **Confidence**: 80%
- **Deep dive**: [`06-storage-security.md`](06-storage-security.md) § Pattern 2

---

## Performance

### H17 — FK sem index correspondente
- **Sinal SQL**:
  ```sql
  SELECT c.conrelid::regclass, a.attname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.contype = 'f'
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid AND a.attnum = i.indkey[0]
    );
  ```
- **Severidade**: **Médio**, **Alto** se tabela > 1M rows
- **Confidence**: 95%
- **Anti-pattern**: [V07](10-common-vulnerabilities.md#v07--fk-sem-%C3%ADndice-m%C3%A9dioalto)
- **Deep dive**: [`03-postgresql-performance.md`](03-postgresql-performance.md) § Index strategy

### H18 — `organization_id` sem index
- **Sinal**: tabela multi-tenant sem index em `(organization_id, ...)`
- **Severidade**: **Alto**
- **Confidence**: 95%

### H19 — Index ANN com operator class errada
- **Sinal**: index HNSW/IVFFlat com `vector_l2_ops` mas queries usam `<=>` (cosine)
- **Severidade**: **Alto** — index não é usado
- **Confidence**: 95%
- **Deep dive**: [`12-pgvector-rag.md`](12-pgvector-rag.md) § HNSW vs IVFFlat

### H20 — Indexes duplicados ou redundantes
- **Sinal SQL**:
  ```sql
  SELECT (array_agg(idx))[1], (array_agg(idx))[2]
  FROM (
    SELECT indexrelid::regclass AS idx,
           indrelid || E'\n' || indkey AS key
    FROM pg_index
  ) sub GROUP BY key HAVING count(*) > 1;
  ```
- **Severidade**: **Baixo** (storage + write overhead)
- **Confidence**: 90%

### H21 — Indexes nunca usados (após >30 dias)
- **Sinal SQL**:
  ```sql
  SELECT schemaname, indexrelname FROM pg_stat_user_indexes
  JOIN pg_index USING (indexrelid)
  WHERE idx_scan = 0 AND NOT indisunique AND schemaname = 'public';
  ```
- **Severidade**: **Baixo** (drop candidato)
- **Confidence**: 70% (pode suportar policy raramente acionada)

---

## Migrations

### H22 — `CREATE INDEX` sem `CONCURRENTLY` em migração
- **Sinal**: grep em `supabase/migrations/*.sql` por `CREATE INDEX` que **não** tenha `CONCURRENTLY`
- **Severidade**: **Alto** se tabela tem volume; **Médio** caso contrário
- **Confidence**: 95%
- **Anti-pattern**: [V08](10-common-vulnerabilities.md#v08--create-index-sem-concurrently-em-produ%C3%A7%C3%A3o-alto)

### H23 — `ALTER TABLE ... NOT NULL` sem `DEFAULT`
- **Sinal**: grep por `ADD COLUMN ... NOT NULL` sem `DEFAULT`
- **Severidade**: **Alto**
- **Confidence**: 95%
- **Anti-pattern**: [V09](10-common-vulnerabilities.md#v09--alter-table--not-null-sem-default-alto)

### H24 — `DROP COLUMN` / `DROP TABLE` direto
- **Sinal**: grep por `DROP COLUMN`, `DROP TABLE` em migrações
- **Severidade**: **Alto** (perda de dados)
- **Confidence**: 95%
- **Anti-pattern**: [V10](10-common-vulnerabilities.md#v10--drop-column-direto-alto)

### H25 — `DELETE` / `UPDATE` sem `WHERE` em migration
- **Sinal**: grep por `DELETE FROM .* (;|$)` ou `UPDATE .* SET .* (;|$)` sem WHERE
- **Severidade**: **Crítico**
- **Confidence**: 100% (pode ser falso positivo só por formatação multi-linha; verificar)

### H26 — Schema drift entre migrations e DB
- **Sinal**: `supabase db diff --linked` retorna output não-vazio
- **Severidade**: **Médio** a **Alto** conforme delta
- **Confidence**: depende do conteúdo
- **Anti-pattern**: [V18](10-common-vulnerabilities.md#v18--migra%C3%A7%C3%B5es-que-n%C3%A3o-est%C3%A3o-em-supabasemigrations-m%C3%A9dio)

---

## Edge Functions

### H27 — Edge Function sem validação de auth
- **Sinal código**: ficheiro `supabase/functions/<x>/index.ts` sem `req.headers.get('Authorization')` ou `getUser()`
- **Severidade**: **Alto** se opera sobre dados de utilizador
- **Confidence**: 80%
- **Anti-pattern**: [V11](10-common-vulnerabilities.md#v11--edge-function-sem-valida%C3%A7%C3%A3o-de-auth-alto)

### H28 — `service_role` usado sem validar permissões
- **Sinal código**: `createClient(url, SERVICE_ROLE_KEY)` antes de `getUser()` na Edge Function
- **Severidade**: **Alto**
- **Confidence**: 85%

### H29 — Webhook sem signature verification
- **Sinal código**: handler de webhook (`stripe-webhook`, `resend-webhook`, etc.) sem `constructEventAsync` ou equivalente
- **Severidade**: **Crítico** (qualquer pessoa pode forjar events)
- **Confidence**: 90%

### H30 — CORS `*` em endpoint autenticado
- **Sinal código**: `Access-Control-Allow-Origin: *` numa função que aceita JWT
- **Severidade**: **Alto** (CSRF + token leak)
- **Confidence**: 90%

### H31 — Input sem validação (Zod / Valibot ausente)
- **Sinal**: Edge Function que faz `req.json()` sem schema parsing
- **Severidade**: **Médio** a **Alto** conforme operação
- **Confidence**: 80%

---

## Realtime

### H32 — Subscription sem `filter` server-side
- **Sinal código**:
  ```ts
  supabase.channel('x').on('postgres_changes', { event: '*', schema: 'public', table: 'X' }, ...)
  ```
  sem `filter: '...=eq.X'`
- **Severidade**: **Médio** (custo + RLS bypass attack surface)
- **Confidence**: 85%
- **Anti-pattern**: [V12](10-common-vulnerabilities.md#v12--realtime-sem-filtro-de-tenant-m%C3%A9dioalto)

### H33 — Realtime ativo em tabela write-heavy
- **Sinal SQL**:
  ```sql
  SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
  ```
  + tabela na lista que tem `audit_logs`, `events`, `telemetry`, etc.
- **Severidade**: **Médio** (custo)
- **Confidence**: 70% (depende do volume real)
- **Anti-pattern**: [V19](10-common-vulnerabilities.md#v19--realtime-ligado-em-tabelas-grandes-m%C3%A9dio)

### H34 — `realtime.messages` sem policies em broadcast/presence
- **Sinal SQL**: ausência de policies em `realtime.messages` quando broadcast/presence está em uso
- **Severidade**: **Alto** (leak entre tenants)
- **Confidence**: 80%

---

## RAG / pgvector

### H35 — Tabela com `vector` sem RLS
- **Sinal SQL**:
  ```sql
  SELECT n.nspname || '.' || c.relname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'vector')
    AND n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = n.nspname AND tablename = c.relname AND rowsecurity = true
    );
  ```
- **Severidade**: **Crítico** se embedding contém conteúdo proprietário
- **Confidence**: 95%

### H36 — OPENAI_API_KEY / embedding API key no cliente
- **Sinal grep**: `NEXT_PUBLIC_.*OPENAI`, `VITE_OPENAI`, `EXPO_PUBLIC_VOYAGE`, etc.
- **Severidade**: **Crítico** (cost abuse + key compromise)
- **Confidence**: 95%

### H37 — Index ANN sem `organization_id` filter em multi-tenant
- **Sinal**: tabela `documents` com `organization_id` mas RPC de search faz `ORDER BY embedding <=> $1 LIMIT 10` sem WHERE
- **Severidade**: **Crítico** (cross-tenant leak via similarity)
- **Confidence**: 90%

---

## Branching / Environments

### H38 — `service_role` partilhado entre ambientes
- **Sinal**: mesma chave em `.env.local` (dev) e CI secrets (prod)
- **Severidade**: **Alto**
- **Confidence**: 70% (precisa confirmação)

### H39 — OAuth app única para múltiplos ambientes
- **Sinal**: mesmo Google/GitHub OAuth client_id em dev e prod
- **Severidade**: **Médio** a **Alto** (depende de scopes)
- **Confidence**: 80%

### H40 — Branch projects sem cleanup automático
- **Sinal**: lista de branches Supabase mais antiga que 14 dias sem atividade
- **Severidade**: **Baixo** (custo) ou **Médio** se branches têm dados sensíveis
- **Confidence**: 80%

---

## CI/CD

### H41 — Sem testes pgTAP para RLS
- **Sinal**: `supabase/tests/` ausente, ou existe mas sem ficheiros em `rls/`
- **Severidade**: **Médio**
- **Confidence**: 90%

### H42 — CI workflow sem `supabase db diff` em PR
- **Sinal**: `.github/workflows/` não corre `supabase db diff --linked` em pull request
- **Severidade**: **Médio** (drift undetected)
- **Confidence**: 85%

### H43 — Generated types out-of-sync no main
- **Sinal**: `types/database.types.ts` commitado difere do output de `supabase gen types typescript --local`
- **Severidade**: **Baixo** (TS aceita campos null que deviam falhar)
- **Confidence**: 95%

---

## Schema / Data integrity

### H44 — Timestamp sem timezone
- **Sinal**: coluna do tipo `timestamp` (não `timestamptz`)
- **Severidade**: **Médio**
- **Confidence**: 95%

### H45 — Dinheiro em float / double
- **Sinal**: coluna de preço/amount com tipo `float`, `double`, `real`
- **Severidade**: **Alto** (precision loss)
- **Confidence**: 100%

### H46 — Boolean nullable
- **Sinal**: `boolean` sem `NOT NULL DEFAULT`
- **Severidade**: **Baixo** (lógica boolean explode)
- **Confidence**: 100%

### H47 — Soft-delete sem partial index
- **Sinal**: coluna `deleted_at` sem index `WHERE deleted_at IS NULL`
- **Severidade**: **Médio** (queries lentas em tabelas grandes)
- **Confidence**: 90%

### H48 — `updated_at` sem trigger
- **Sinal**: coluna `updated_at` mas nenhum trigger `BEFORE UPDATE ... set_updated_at()`
- **Severidade**: **Médio** (cache invalidation quebra)
- **Confidence**: 90%

### H49 — `tenant_id` mutável (sem trigger ou WITH CHECK)
- **Sinal**: tabela com `organization_id` permite UPDATE sem constraint
- **Severidade**: **Alto** (cross-tenant data move)
- **Confidence**: 80%

---

## Production hygiene

### H50 — `anon` com privilégios excessivos
- **Sinal SQL**:
  ```sql
  SELECT table_name, privilege_type FROM information_schema.table_privileges
  WHERE grantee = 'anon' AND table_schema = 'public';
  ```
  com mais privilégios do que `SELECT` em poucas tabelas específicas
- **Severidade**: **Alto**
- **Confidence**: 85%
- **Anti-pattern**: [V17](10-common-vulnerabilities.md#v17--anon-com-privil%C3%A9gios-excessivos-alto)

### H51 — Sem PITR / backups não testados
- **Sinal**: plano Supabase sem PITR, ou restore drill nunca documentado
- **Severidade**: **Alto** em produção
- **Confidence**: 90%

### H52 — Sem rate limiting em endpoints custom
- **Sinal**: Edge Function exposta sem rate limit (platform ou custom via SQL)
- **Severidade**: **Médio**
- **Confidence**: 75%

---

## Como atualizar este catálogo

1. **Nova heurística**: adicionar `H<NN+1>` no final da secção apropriada. Nunca renumerar.
2. **Refinar existente**: editar in-place. Documentar mudança no CHANGELOG.
3. **Deprecar**: marcar como `~~H<N>~~ (deprecada na v<x>)`. Não apagar (mantém rastreabilidade histórica).
4. **Cross-reference**: cada reference ao adicionar pattern deve apontar para o ID da heurística aqui.

## Cobertura

| Categoria | IDs | Total |
|---|---|---|
| RLS | H01–H06 | 6 |
| Auth / Secrets | H07–H13 | 7 |
| Storage | H14–H16 | 3 |
| Performance | H17–H21 | 5 |
| Migrations | H22–H26 | 5 |
| Edge Functions | H27–H31 | 5 |
| Realtime | H32–H34 | 3 |
| RAG / pgvector | H35–H37 | 3 |
| Branching / Env | H38–H40 | 3 |
| CI/CD | H41–H43 | 3 |
| Schema integrity | H44–H49 | 6 |
| Production hygiene | H50–H52 | 3 |
| **Total** | **H01–H52** | **52** |

---

## Apêndice — Query agregada de detecção

Correr no SQL Editor do projeto a auditar (Supabase Studio). Junta as queries das principais heurísticas num só relatório:

```sql
-- Heurísticas H01, H02, H06 (RLS)
SELECT 'H01 RLS missing' AS heuristic, tablename FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false
UNION ALL
SELECT 'H02 USING (true)', tablename || '.' || policyname FROM pg_policies
WHERE schemaname = 'public' AND qual = 'true'
UNION ALL
SELECT 'H06 RLS no policies', t.tablename FROM pg_tables t
LEFT JOIN pg_policies p USING (schemaname, tablename)
WHERE t.schemaname = 'public' AND t.rowsecurity = true AND p.policyname IS NULL
UNION ALL
-- H09 SECURITY DEFINER sem search_path
SELECT 'H09 SecDef no search_path', n.nspname || '.' || p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef = true AND n.nspname IN ('public','auth')
  AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
UNION ALL
-- H14 Buckets públicos
SELECT 'H14 Public bucket', id FROM storage.buckets WHERE public = true
UNION ALL
-- H17 FK sem index
SELECT 'H17 FK no index', c.conrelid::regclass || '.' || a.attname
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = i.indkey[0]
  )
UNION ALL
-- H50 Privilege grants em anon
SELECT 'H50 Anon priv', table_name || ':' || privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'anon' AND table_schema = 'public' AND privilege_type != 'SELECT';
```

Resultado: lista com 1 linha por heurística disparada. Ponto de partida sólido para qualquer audit.
