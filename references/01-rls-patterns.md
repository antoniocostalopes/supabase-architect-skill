# RLS Patterns — Row Level Security em Supabase

Referência de padrões corretos (e errados) para RLS. Cobre os 90% dos casos de SaaS.

## Fundamentos

### Activar RLS
```sql
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
-- RLS sem policies = nega tudo aos roles não-superuser.
```

### Forçar RLS para o próprio owner
```sql
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
-- Sem isto, o owner da tabela (postgres role) ignora RLS.
-- Útil para evitar surpresas em scripts admin.
```

### Estrutura de uma policy
```sql
CREATE POLICY <nome>
ON <tabela>
[AS PERMISSIVE | RESTRICTIVE]  -- default PERMISSIVE
FOR <SELECT | INSERT | UPDATE | DELETE | ALL>
TO <role>                       -- default PUBLIC (= todos os roles)
USING (<expr_select_update_delete>)
WITH CHECK (<expr_insert_update>);
```

### `USING` vs `WITH CHECK`
- `USING` — filtra **que linhas o role pode ler/atualizar/apagar** (SELECT/UPDATE/DELETE)
- `WITH CHECK` — valida **linhas a inserir/após update** (INSERT/UPDATE)
- Para UPDATE: ambas se aplicam. `USING` decide quais podem ser tocadas; `WITH CHECK` valida o novo estado.

### Roles relevantes no Supabase
- `anon` — utilizador não autenticado (visitante anónimo)
- `authenticated` — utilizador com JWT válido
- `service_role` — bypass de RLS (server-only)
- `postgres` — owner; bypass de RLS salvo `FORCE ROW LEVEL SECURITY`

## Pattern 1 — User-owned (single tenant)

Caso clássico: cada utilizador vê apenas o que é dele.

```sql
-- Tabela
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

-- Policies separadas por operação (melhor para auditoria)
CREATE POLICY "notes_select_own" ON public.notes
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "notes_insert_own" ON public.notes
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "notes_update_own" ON public.notes
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "notes_delete_own" ON public.notes
FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- Index suportando a policy
CREATE INDEX idx_notes_user_id ON public.notes(user_id);
```

**Porquê separar policies por operação**: permite revogar uma operação sem reescrever as outras, e auditoria fica explícita.

## Pattern 2 — Organization-owned (multi-tenant SaaS)

Caso central de qualquer SaaS B2B.

### Schema base

```sql
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_memberships_user_active ON public.memberships(user_id) WHERE is_active = true;
CREATE INDEX idx_memberships_org ON public.memberships(organization_id);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
```

### Helper function (recomendado)

```sql
CREATE OR REPLACE FUNCTION public.is_member(target_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = target_org
      AND user_id = auth.uid()
      AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role(target_org uuid, required_roles public.member_role[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = target_org
      AND user_id = auth.uid()
      AND is_active = true
      AND role = ANY(required_roles)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.member_role[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.member_role[]) TO authenticated;
```

**Porquê helper**: policies ficam legíveis e o planner pode cachear o resultado por linha. `SECURITY DEFINER` permite consultar `memberships` mesmo que o utilizador não tenha policy de leitura direta.

### Policies em tabela de tenant

```sql
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- READ: membros ativos veem documentos vivos
CREATE POLICY "documents_select" ON public.documents
FOR SELECT TO authenticated
USING (
  deleted_at IS NULL
  AND public.is_member(organization_id)
);

-- INSERT: membros podem criar; created_by tem de ser o próprio
CREATE POLICY "documents_insert" ON public.documents
FOR INSERT TO authenticated
WITH CHECK (
  public.is_member(organization_id)
  AND created_by = auth.uid()
);

-- UPDATE: admins/owners ou o próprio criador
CREATE POLICY "documents_update" ON public.documents
FOR UPDATE TO authenticated
USING (
  deleted_at IS NULL
  AND (
    public.has_role(organization_id, ARRAY['owner','admin']::public.member_role[])
    OR created_by = auth.uid()
  )
)
WITH CHECK (
  public.is_member(organization_id)
  AND organization_id = (SELECT d.organization_id FROM public.documents d WHERE d.id = documents.id)
);

-- DELETE: só owners/admins (e usar soft-delete em vez disto)
CREATE POLICY "documents_delete" ON public.documents
FOR DELETE TO authenticated
USING (
  public.has_role(organization_id, ARRAY['owner','admin']::public.member_role[])
);
```

### Indexes obrigatórios

```sql
CREATE INDEX idx_documents_org_created ON public.documents(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_creator ON public.documents(created_by);
```

## Pattern 3 — Public read, authenticated write

Para blog, marketing, catálogo público.

```sql
CREATE POLICY "posts_public_read" ON public.posts
FOR SELECT TO anon, authenticated
USING (published_at IS NOT NULL AND published_at <= now());

CREATE POLICY "posts_author_write" ON public.posts
FOR INSERT TO authenticated
WITH CHECK (author_id = auth.uid());

CREATE POLICY "posts_author_update" ON public.posts
FOR UPDATE TO authenticated
USING (author_id = auth.uid())
WITH CHECK (author_id = auth.uid());
```

## Pattern 4 — Admin-only

Para feature flags, settings globais, dashboards internos.

```sql
-- Helper para admins de plataforma (não de tenant)
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT (auth.jwt() ->> 'role') = 'platform_admin';
$$;

-- Em alternativa, tabela de platform_admins:
CREATE TABLE public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
-- Sem policies = só service_role acede.

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid());
$$;

CREATE POLICY "feature_flags_admin_only" ON public.feature_flags
FOR ALL TO authenticated
USING (public.is_platform_admin())
WITH CHECK (public.is_platform_admin());
```

## Pattern 5 — Sharing por link/token

Recurso privado mas partilhável com token.

```sql
CREATE TABLE public.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  permission text NOT NULL CHECK (permission IN ('view','comment'))
);

-- Para validar via header customizado, usar Edge Function que valida e devolve dados.
-- RLS direto não consegue ler headers HTTP fora do JWT.
```

Para validação via JWT custom claim (link partilhado faz login anónimo + claim no JWT), ver `05-auth-security.md`.

## Pattern 6 — Hierarquia (projetos dentro de orgs)

```sql
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- Denormalizar organization_id para policy direta (recomendado)
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title text NOT NULL
);

-- Trigger para manter organization_id consistente
CREATE OR REPLACE FUNCTION public.sync_task_org()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT organization_id INTO NEW.organization_id
  FROM public.projects WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_task_org
BEFORE INSERT OR UPDATE OF project_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.sync_task_org();

-- Policy direta (rápida, sem JOIN)
CREATE POLICY "tasks_select" ON public.tasks
FOR SELECT TO authenticated
USING (public.is_member(organization_id));
```

**Porquê denormalizar `organization_id`**: evita JOIN em cada policy check. Em tabelas com milhões de linhas, faz diferença de ordens de magnitude.

## Anti-patterns (não fazer)

### A1. Policy `FOR ALL` genérica
```sql
-- ERRADO
CREATE POLICY "wat" ON public.x FOR ALL USING (true);
```
Cobre as 4 operações com a mesma regra; dificulta auditoria e quase nunca é o que queres.

### A2. `USING (auth.role() = 'authenticated')`
```sql
-- ERRADO
CREATE POLICY "logged_in" ON public.invoices FOR SELECT USING (auth.role() = 'authenticated');
```
Permite a **qualquer** utilizador autenticado ler **tudo**. Equivalente a estar logado = admin.

### A3. Subquery sem `LIMIT` em policy
```sql
-- Mau para performance
USING (
  organization_id = (SELECT organization_id FROM memberships WHERE user_id = auth.uid())
)
```
Se o utilizador tem múltiplas memberships, falha. Usar `IN (...)` ou helper.

### A4. Misturar lógica de auth com lógica de negócio na policy
```sql
-- Mau: difícil de testar/debug
USING (
  organization_id IN (...)
  AND status != 'archived'
  AND created_at > now() - interval '30 days'
)
```
A policy é para **autorização**. Filtros de negócio devem ficar na query do cliente.

### A5. `EXISTS (...)` sem index
Toda subquery em policy precisa de index a suportar — `memberships(user_id)` é obrigatório.

## Checklist de auditoria RLS

Para cada tabela em `public.*`:

- [ ] `rowsecurity = true` em `pg_tables`?
- [ ] Tem pelo menos uma policy para cada operação que deve ser permitida?
- [ ] Cobre o role correto (`anon` / `authenticated`)?
- [ ] Filtra por `organization_id` (se multi-tenant)?
- [ ] Tem index a suportar a expressão da policy?
- [ ] `WITH CHECK` em INSERT/UPDATE valida o novo estado?
- [ ] Soft-delete (`deleted_at IS NULL`) presente em SELECT se aplicável?
- [ ] Não usa `USING (true)` salvo em tabela genuinamente pública?
- [ ] Operações destrutivas (DELETE) restritas a roles privilegiados?

## Query de diagnóstico (cola e corre)

```sql
-- Tabelas em public sem RLS
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false
ORDER BY tablename;

-- Policies por tabela
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;

-- Tabelas com RLS mas sem policies (= nega tudo)
SELECT t.tablename
FROM pg_tables t
LEFT JOIN pg_policies p USING (schemaname, tablename)
WHERE t.schemaname = 'public'
  AND t.rowsecurity = true
  AND p.policyname IS NULL;
```
