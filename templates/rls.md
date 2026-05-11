# Template — SUPABASE_RLS.md

Estrutura fixa para output de geração/auditoria de RLS.

---

```markdown
# SUPABASE_RLS — <project_name>

> Gerado por **Supabase Architect** em <YYYY-MM-DD>.
> Escopo: <todas as tabelas | tabela X | módulo Y>.

## Estado atual

### RLS coverage
| Tabela | RLS ativa | Policies | Risco |
|---|---|---|---|
| public.organizations | ✅ | 4 | OK |
| public.documents | ❌ | 0 | **Crítico** |
| … | | | |

### Helpers presentes
- `public.is_member(uuid)`: ✅ / ❌
- `public.has_role(uuid, member_role)`: ✅ / ❌
- `public.role_in(uuid)`: ✅ / ❌

## Problemas detectados

### [CRÍTICO] Tabelas sem RLS
- `public.documents`
- `public.invoices`

```sql
-- Fix
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
```

### [CRÍTICO] Policies USING (true)
- `public.posts` policy `"public_read"` — confirmar se a tabela deve mesmo ser pública.

### [ALTO] Policies sem filtro de tenant
- `public.tasks` policy `"tasks_select"` filtra apenas por `user_id`.

## Helpers (criar se ainda não existem)

```sql
CREATE OR REPLACE FUNCTION public.is_member(target_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = target_org
      AND user_id = auth.uid()
      AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role(target_org uuid, min_role public.member_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH user_role AS (
    SELECT role FROM public.memberships
    WHERE organization_id = target_org AND user_id = auth.uid() AND is_active = true
  )
  SELECT CASE (SELECT role FROM user_role)
    WHEN 'owner'  THEN min_role IN ('owner','admin','member','viewer')
    WHEN 'admin'  THEN min_role IN ('admin','member','viewer')
    WHEN 'member' THEN min_role IN ('member','viewer')
    WHEN 'viewer' THEN min_role = 'viewer'
    ELSE false
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.member_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.member_role) TO authenticated;
```

## Policies por tabela

### public.documents

```sql
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_select" ON public.documents
FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND public.is_member(organization_id)
);

CREATE POLICY "documents_insert" ON public.documents
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(organization_id, 'member')
  AND created_by = auth.uid()
);

CREATE POLICY "documents_update" ON public.documents
FOR UPDATE TO authenticated
USING (
  deleted_at IS NULL
  AND (
    public.has_role(organization_id, 'admin')
    OR created_by = auth.uid()
  )
)
WITH CHECK (
  public.is_member(organization_id)
);

CREATE POLICY "documents_delete" ON public.documents
FOR DELETE TO authenticated
USING (
  public.has_role(organization_id, 'admin')
);
```

Indexes a suportar:
```sql
CREATE INDEX IF NOT EXISTS idx_documents_org_alive
  ON public.documents(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_creator
  ON public.documents(created_by);
```

### public.<outra_tabela>
…

## Testes de RLS

Para cada policy, validar com queries de teste:

```sql
-- Como user X da Org A, posso ler docs da Org A?
SET request.jwt.claims = '{"sub":"<user_a_uuid>","role":"authenticated"}';
SELECT count(*) FROM public.documents
WHERE organization_id = '<org_a_uuid>';
-- Esperado: N > 0

-- Como user X da Org A, posso ler docs da Org B?
SELECT count(*) FROM public.documents
WHERE organization_id = '<org_b_uuid>';
-- Esperado: 0

RESET request.jwt.claims;
```

Recomendado: criar suite de testes via [`supabase-test-helpers`](https://github.com/supabase/supabase-test-helpers) ou `pgTAP`.

## Verificação final

Correr no SQL Editor:

```sql
-- 1. RLS coverage gap
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false;

-- 2. Tabelas com RLS mas sem policies
SELECT t.tablename FROM pg_tables t
LEFT JOIN pg_policies p USING (schemaname, tablename)
WHERE t.schemaname = 'public' AND t.rowsecurity = true AND p.policyname IS NULL;

-- 3. Policies USING (true)
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND qual = 'true';
```

Esperado: queries retornam **vazias** após aplicar as correções acima.
```
