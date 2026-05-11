# Example — SUPABASE_RLS.md (SaaS B2B)

Exemplo few-shot do output do comando `/supabase-rls` em projeto SaaS B2B com `organizations` + `memberships`. Mostra geração de policies completas para 1 tabela nova + audit das existentes.

Contexto: developer pediu `/supabase-rls fix-all` num projeto com 4 tabelas (`organizations`, `memberships`, `deals`, `comments`). `comments` é nova e `deals` tem policy quebrada.

---

```markdown
# SUPABASE_RLS — acme-crm

> Gerado por **Supabase Architect** em 2026-05-11.
> Escopo: audit completo + geração para `comments` (tabela nova).

## Estado atual

### RLS coverage
| Tabela | RLS ativa | Policies | Risco | Heurística |
|---|---|---|---|---|
| public.organizations | ✅ | 4 | OK | — |
| public.memberships | ✅ | 3 | OK | — |
| public.deals | ✅ | 4 | **Alto** — policy quebrada | H03 |
| public.comments | ❌ | 0 | **Crítico** | H01 |

### Helpers presentes
- `public.is_member(uuid)` — ✅
- `public.has_role(uuid, member_role)` — ✅

Estes serão reutilizados nas policies novas.

## Problemas detectados

### [CRÍTICO · 95% · H01] `comments` sem RLS
Tabela contém comentários a deals. Sem RLS, qualquer authenticated lê comentários de qualquer org.

### [ALTO · 90% · H03] `deals_update` permite a qualquer member editar
Policy actual:
```sql
CREATE POLICY "deals_update" ON public.deals
FOR UPDATE TO authenticated
USING (public.is_member(organization_id));
```

Permite a viewers (role mais baixo) fazer UPDATE. Deveria ser member ou superior.

## Fix completo

### 1. RLS para `comments` (nova)

```sql
-- Activar RLS
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

-- SELECT: membros da org dona do deal
CREATE POLICY "comments_select" ON public.comments
FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND public.is_member(organization_id)
);

-- INSERT: members podem comentar; created_by tem de ser o próprio
CREATE POLICY "comments_insert" ON public.comments
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(organization_id, 'member')
  AND created_by = auth.uid()
);

-- UPDATE: só o autor pode editar o seu comentário (até 5min após criação, em RPC à parte)
CREATE POLICY "comments_update_own" ON public.comments
FOR UPDATE TO authenticated
USING (
  created_by = auth.uid()
  AND deleted_at IS NULL
)
WITH CHECK (
  created_by = auth.uid()
  AND organization_id = (SELECT c.organization_id FROM public.comments c WHERE c.id = comments.id)
);

-- DELETE: autor ou admin
CREATE POLICY "comments_delete" ON public.comments
FOR DELETE TO authenticated
USING (
  created_by = auth.uid()
  OR public.has_role(organization_id, 'admin')
);

-- Index a suportar
CREATE INDEX IF NOT EXISTS idx_comments_org_deal_created
  ON public.comments(organization_id, deal_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comments_creator
  ON public.comments(created_by);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comments TO authenticated;
```

### 2. Fix `deals_update`

```sql
DROP POLICY "deals_update" ON public.deals;

CREATE POLICY "deals_update_member_or_above" ON public.deals
FOR UPDATE TO authenticated
USING (
  deleted_at IS NULL
  AND public.has_role(organization_id, 'member')
)
WITH CHECK (
  public.has_role(organization_id, 'member')
  AND organization_id = (SELECT d.organization_id FROM public.deals d WHERE d.id = deals.id)
);
```

## Testes manuais (psql / SQL Editor)

```sql
-- Simular user A da Org A
SET request.jwt.claims = '{"sub":"<user_a_uuid>","role":"authenticated"}';

-- T1: user A vê apenas comments da Org A
SELECT count(*) FROM public.comments WHERE organization_id = '<org_a_uuid>';
-- Esperado: > 0

SELECT count(*) FROM public.comments WHERE organization_id = '<org_b_uuid>';
-- Esperado: 0

-- T2: insert na própria org funciona
INSERT INTO public.comments (organization_id, deal_id, created_by, content)
VALUES ('<org_a_uuid>', '<deal_a_uuid>', '<user_a_uuid>', 'test')
RETURNING id;
-- Esperado: sucesso

-- T3: insert noutra org falha
INSERT INTO public.comments (organization_id, deal_id, created_by, content)
VALUES ('<org_b_uuid>', '<deal_b_uuid>', '<user_a_uuid>', 'cross-tenant attempt');
-- Esperado: erro 42501 (RLS block)

-- T4: anonymous não vê nada
RESET request.jwt.claims;
SET ROLE anon;
SELECT count(*) FROM public.comments;
-- Esperado: 0

RESET ROLE;
```

## Recomendação: criar suite pgTAP

Adicionar `supabase/tests/rls/comments_test.sql` cobrindo os casos T1-T4. Ver `references/13-ci-cd-testing.md` para template.

## Verificação final

```sql
-- 1. RLS coverage gap
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false;
-- Esperado: vazio

-- 2. Tabelas com RLS sem policies
SELECT t.tablename FROM pg_tables t
LEFT JOIN pg_policies p USING (schemaname, tablename)
WHERE t.schemaname = 'public' AND t.rowsecurity = true AND p.policyname IS NULL;
-- Esperado: vazio

-- 3. Policies USING (true)
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND qual = 'true';
-- Esperado: vazio

-- 4. Policies de comments existem
SELECT policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'comments';
-- Esperado: 4 rows (select, insert, update, delete)
```
```

---

## Notas — uso deste example

- Compacto: foca apenas no output do `/supabase-rls`, não duplica o que vai no audit completo.
- **Heurística cited** (H01, H03) — rastreabilidade com `references/HEURISTICS.md`.
- **Testes manuais** incluídos: o developer pode validar imediatamente.
- **pgTAP recomendado** mas não obrigatório no output (rede de segurança).
- Cita helpers existentes (`is_member`, `has_role`) — não cria a partir do zero se já existem.
