# Expected Outputs — Eval Suite

Para cada prompt em [`prompts.md`](prompts.md), aqui ficam os **sinais esperados** no output da skill. Não é um output completo verbatim — é um checklist de elementos que **devem** aparecer.

---

## P01 — Audit completo (SaaS B2B)

**Ativação esperada**:
- Skill `supabase-architect` ou `/supabase-audit`
- Anuncia "Vou aplicar auditoria das 13 lentes"

**References a carregar**: todas (audit completo)

**Template esperado**: `templates/audit.md` → output `SUPABASE_AUDIT.md`

**Few-shot esperado**: `examples/audit-example-saas-multi-tenant.md`

**Achados a detetar (mínimo)**:
- [CRÍTICO] RLS missing em `invoices` (a tabela sem `ENABLE ROW LEVEL SECURITY`)
- Mapeamento de `organizations` + `memberships` reconhecido como tenant model
- Sumário com score 0-100
- Plano de correção em 4 fases

**Red flags**:
- Não reconhece padrão multi-tenant
- Output genérico que não menciona as tabelas específicas

---

## P02 — Review de policy individual

**Ativação esperada**: `/supabase-rls` ou skill

**References a carregar**:
- `references/01-rls-patterns.md`
- `references/02-multi-tenant-patterns.md`
- `references/10-common-vulnerabilities.md` (V02, V03)

**Achados esperados**:
- [CRÍTICO/ALTO] `USING (auth.role() = 'authenticated')` permite a **qualquer** authenticated ler tudo — não é tenant isolation
- Aponta V03 (Policy sem filtro de tenant)
- Sugere `USING (public.is_member(organization_id))` ou equivalente
- Index a suportar

**Red flags**:
- Marca como apenas "Médio" (under-rate)
- Não sugere helper function
- Sugere `USING (true)` como alternativa

---

## P03 — Review de migração antes de produção

**Ativação esperada**: `/supabase-migrations`

**References a carregar**:
- `references/04-migration-safety.md`
- `references/10-common-vulnerabilities.md` (V09, V08)

**Achados esperados**:
- [ALTO] `ADD COLUMN tier text NOT NULL` sem `DEFAULT` em tabela com 8M rows → falha imediata
- [ALTO] `CREATE INDEX` sem `CONCURRENTLY` em tabela grande → lock de escrita
- Solução em 3 fases (expand/contract): add nullable + backfill batches + enforce NOT NULL
- SQL com `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
- Rollback documentado

**Red flags**:
- Aprova a migração como está
- Não menciona expand/contract para o backfill
- Não menciona CONCURRENTLY

---

## P04 — Investigar query lenta

**Ativação esperada**: `/supabase-performance`

**References a carregar**:
- `references/03-postgresql-performance.md`
- `references/10-common-vulnerabilities.md` (V07)

**Achados esperados**:
- Falta index composto `(organization_id, status, created_at DESC)` ou partial `WHERE status = 'pending'`
- Sugestão de `EXPLAIN ANALYZE` para confirmar antes/depois
- `SELECT *` mencionado como anti-pattern
- Considera RLS overhead se a policy não está indexada

**SQL esperado** (exemplo):
```sql
CREATE INDEX CONCURRENTLY idx_orders_org_status_created
  ON public.orders(organization_id, status, created_at DESC);
-- ou partial:
CREATE INDEX CONCURRENTLY idx_orders_pending
  ON public.orders(organization_id, created_at DESC) WHERE status = 'pending';
```

**Red flags**:
- Sugere index simples `(organization_id)` em vez de composto
- Recomenda `LIMIT` mais agressivo como "fix" (não resolve a causa)

---

## P05 — Bucket de storage com PII

**Ativação esperada**: `/supabase-storage`

**References a carregar**:
- `references/06-storage-security.md`
- `references/10-common-vulnerabilities.md` (V05)

**Achados esperados**:
- [CRÍTICO] Bucket `public: true` com contratos = PII exposta via URL público
- [ALTO] Paths `<deal_id>-<filename>.pdf` são **enumerable** (deal_id sequencial?)
- Fix: `UPDATE storage.buckets SET public = false WHERE id = 'documents'`
- Refactor para path tenant-aware: `<org_id>/<deal_id>/<filename>.pdf`
- Substituir `getPublicUrl` por `createSignedUrl` com TTL curto
- Policies em `storage.objects` por path-based ownership

**Red flags**:
- Marca como Médio
- Não menciona migração de paths existentes

---

## P06 — Setup RAG / pgvector

**Ativação esperada**: `/supabase-rag setup`

**References a carregar**:
- `references/12-pgvector-rag.md`
- `references/01-rls-patterns.md`
- `references/02-multi-tenant-patterns.md`
- `references/08-edge-functions-security.md`

**Template esperado**: `templates/rag.md`

**Output esperado**:
- `CREATE EXTENSION vector`
- Schema com `embedding vector(1024)` ou `vector(1536)` (depende do modelo escolhido)
- `organization_id` denormalizado
- Index HNSW com `vector_cosine_ops`
- Partial index em `content_tsv` para hybrid search
- RLS com `is_member(organization_id)`
- RPC `search_documents` com `SECURITY DEFINER`
- RPC `hybrid_search` com RRF
- Edge Function `embed-document` skeleton (server-side, com auth check)

**Red flags**:
- Sugere embedding no cliente (OPENAI_API_KEY no frontend)
- Index com `vector_l2_ops` quando query usa `<=>` (cosine)
- Sem filtro de tenant nas RPCs
- Não menciona chunking strategy

---

## P07 — MFA enforcement enterprise

**Ativação esperada**: `/supabase-auth`

**References a carregar**:
- `references/05-auth-security.md` (secção MFA / TOTP)

**Output esperado**:
- Detecção de AAL2 via `auth.jwt() ->> 'aal'`
- Policy `RESTRICTIVE` que exige `(auth.jwt() ->> 'aal') = 'aal2'` em tabelas de billing
- Query para encontrar admins/owners sem MFA enrolled (auditoria)
- Distinção AAL1 vs AAL2 clara

**SQL esperado**:
```sql
CREATE POLICY "billing_aal2" ON public.billing_secrets
FOR SELECT TO authenticated
USING (
  public.has_role(organization_id, 'admin')
  AND (auth.jwt() ->> 'aal') = 'aal2'
);
```

**Red flags**:
- Sugere implementar MFA "from scratch" em vez de usar Supabase native
- Não menciona `auth.mfa_factors` para audit

---

## P08 — Production readiness

**Ativação esperada**: `/supabase-production-check`

**References a carregar**:
- `references/09-production-checklist.md`
- Todas as outras (varredura completa)

**Template esperado**: `templates/production.md` → `SUPABASE_PRODUCTION.md`

**Output esperado**:
- Veredicto explícito: READY ou NOT READY (uma frase)
- Score por secção (A. Security, B. Performance, etc.) + total
- Lista de **bloqueadores** (impedem ship)
- Lista de **riscos altos**
- Plano de remediação em 3 ondas (pré-ship, 1ª semana, 1º mês)
- Queries SQL de re-verificação

**Red flags**:
- Veredicto vago ("provavelmente pronto")
- Score sem justificação
- Sem bloqueadores quando há RLS missing ou service_role exposto

---

## P09 — Multi-tenant policy generation

**Ativação esperada**: `/supabase-rls`

**References a carregar**:
- `references/01-rls-patterns.md`
- `references/02-multi-tenant-patterns.md`

**Output esperado**:
- 4 policies separadas: SELECT, INSERT, UPDATE, DELETE
- Cada uma usa helper `is_member` ou `has_role`
- DELETE restrito a `has_role(... 'admin')`
- `WITH CHECK` em INSERT/UPDATE para garantir não-mudança de tenant
- Index a suportar: `(organization_id, created_at DESC)`
- `ALTER TABLE deals ENABLE ROW LEVEL SECURITY` no início

**Red flags**:
- Policy única `FOR ALL`
- Sem `WITH CHECK` em INSERT
- DELETE acessível a member regular
- Sem index proposto

---

## P10 — Edge Function audit (webhook Stripe)

**Ativação esperada**: `/supabase-edge-functions`

**References a carregar**:
- `references/08-edge-functions-security.md`

**Achados esperados** (genéricos, dependendo do que foi mostrado):
- Validação de signature Stripe (`stripe.webhooks.constructEventAsync`)
- Idempotência via `event.id` único
- CORS apropriado (não `*` para endpoint autenticado)
- Logs não contêm payload completo com PII
- Erro genérico para o cliente; detalhe nos logs do servidor

**Skeleton fornecido**: webhook handler completo com 6 passos (signature → parse → idempotency check → business logic → response)

**Red flags**:
- Não menciona signature
- Sugere `service_role` direto sem validar
- Catch genérico que devolve `err.stack` ao cliente

---

## P11 — Hotel / booking

**Ativação esperada**: skill, com domain detection

**Few-shot esperado**: `examples/audit-example-hotel.md`

**Output esperado**:
- Recomenda `tstzrange` + `EXCLUDE USING gist`
- `CREATE EXTENSION IF NOT EXISTS btree_gist`
- Generated column `stay_range`
- Constraint `bookings_no_overlap` com `WHERE (status IN ('confirmed', 'pending'))`
- Menção a `room_id WITH =, stay_range WITH &&`

**SQL esperado**:
```sql
ALTER TABLE public.bookings
  ADD COLUMN stay_range tstzrange
  GENERATED ALWAYS AS (tstzrange(checkin_at, checkout_at, '[)')) STORED;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (room_id WITH =, stay_range WITH &&)
  WHERE (status IN ('confirmed', 'pending'));
```

**Red flags**:
- Sugere validação aplicacional only (sem constraint DB)
- Usa range BTREE em vez de GiST
- Não menciona `btree_gist`
- Aplica padrão SaaS B2B (não reconhece domínio hotel)

---

## P12 — CI/CD com pgTAP

**Ativação esperada**: skill, carregando `references/13-ci-cd-testing.md`

**Output esperado**:
- `CREATE EXTENSION pgtap`
- Helpers em `supabase/tests/helpers.sql` (`tests.authenticate_as`, `create_user_with_org`)
- Exemplo de teste RLS com casos cross-tenant + anonymous + tenant immutability
- Workflow GitHub Actions `.github/workflows/supabase.yml`:
  - `supabase start` + `supabase db reset`
  - Squawk lint
  - pgTAP suite
  - Verificação de generated types in-sync
- Branch protection settings

**Red flags**:
- Não menciona Squawk (só pgTAP)
- Sem cross-tenant test cases
- Sem branch protection mencionado

---

## Notas de avaliação

Ao avaliar, **não procurar** correspondência verbatim. Procurar que os **conceitos certos** apareçam.

A skill pode usar palavras ligeiramente diferentes; o que importa é:
- Conceito técnico correto
- SQL/código aplicável diretamente
- Severidade adequada
- Citation explícito
