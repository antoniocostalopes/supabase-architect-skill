# Multi-tenant Patterns para SaaS em Supabase

Padrões para construir SaaS B2B/B2B2C onde os dados de cada cliente (tenant) ficam estritamente isolados.

## Modelo de tenants

### Pergunta-chave do design
> Um cliente é uma **organização** (com vários utilizadores) ou um **utilizador** (com workspace pessoal)?

| Modelo | Tabela raiz | Quem paga | Membros | Exemplos |
|---|---|---|---|---|
| User-as-tenant | `auth.users` | Utilizador | Só ele | Notion pessoal, Linear single-user |
| Organization-as-tenant | `organizations` | Org | N utilizadores via `memberships` | Slack, Stripe Dashboard, Linear teams |
| Workspace-per-user | `workspaces` 1:1 com user + N convidados | Owner | N | Notion (modelo atual), Figma free |
| Hierárquico | `organizations → workspaces → projects` | Org | Varia por nível | Vercel, GitHub Enterprise |

Esta referência foca **organization-as-tenant**, o caso mais frequente em SaaS B2B.

## Schema canónico

```sql
-- 1. Organizations (raiz de tudo)
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_organizations_alive ON public.organizations(id) WHERE deleted_at IS NULL;

-- 2. Roles enumeradas
CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member', 'viewer');

-- 3. Memberships (join table)
CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  is_active boolean NOT NULL DEFAULT true,
  invited_by uuid REFERENCES auth.users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_memberships_user_active
  ON public.memberships(user_id)
  WHERE is_active = true;

CREATE INDEX idx_memberships_org_role
  ON public.memberships(organization_id, role);

-- 4. Invites (separado de memberships)
CREATE TABLE public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  token text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitations_pending
  ON public.invitations(organization_id, email)
  WHERE accepted_at IS NULL AND expires_at > now();
```

## Regra-de-ouro: `organization_id` em TODAS as tabelas de tenant

Toda tabela que contém dados de tenant tem **`organization_id` denormalizado** mesmo que possa ser derivado por JOIN.

```sql
-- Mesmo que projects pertença a organização, tasks denormaliza:
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  ...
);

-- Trigger para garantir consistência
CREATE OR REPLACE FUNCTION public.sync_tenant_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS NULL OR NEW.organization_id <> (
    SELECT organization_id FROM public.projects WHERE id = NEW.project_id
  ) THEN
    SELECT organization_id INTO NEW.organization_id
    FROM public.projects WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tasks_sync_tenant
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.sync_tenant_id();
```

**Porquê**:
1. **Performance**: policy direta sem JOIN ↓ ordens de magnitude vs `EXISTS (SELECT ... JOIN projects ...)`
2. **Indexes**: indexes compostos `(organization_id, ...)` viram triviais
3. **Auditoria**: cada linha tem provenance evidente
4. **Particionamento futuro**: pode particionar por `organization_id` se precisar

## Helpers de autorização

```sql
-- Saber se o user atual é membro ativo
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

-- Saber o role do user na org
CREATE OR REPLACE FUNCTION public.role_in(target_org uuid)
RETURNS public.member_role LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT role FROM public.memberships
  WHERE organization_id = target_org AND user_id = auth.uid() AND is_active = true;
$$;

-- Verificar se tem pelo menos role X
CREATE OR REPLACE FUNCTION public.has_role(target_org uuid, min_role public.member_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH user_role AS (
    SELECT role FROM public.memberships
    WHERE organization_id = target_org AND user_id = auth.uid() AND is_active = true
  )
  SELECT CASE (SELECT role FROM user_role)
    WHEN 'owner'   THEN min_role IN ('owner','admin','member','viewer')
    WHEN 'admin'   THEN min_role IN ('admin','member','viewer')
    WHEN 'member'  THEN min_role IN ('member','viewer')
    WHEN 'viewer'  THEN min_role = 'viewer'
    ELSE false
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.role_in(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.member_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_in(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.member_role) TO authenticated;
```

## Padrão de policies (template)

Para cada tabela de tenant, aplicar este conjunto:

```sql
ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;

-- SELECT: qualquer membro ativo (filtra deleted se aplicável)
CREATE POLICY "<table>_select" ON public.<table>
FOR SELECT TO authenticated
USING (
  public.is_member(organization_id)
  -- AND deleted_at IS NULL  -- se soft-delete
);

-- INSERT: membros (regra mínima); pode restringir por role
CREATE POLICY "<table>_insert" ON public.<table>
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(organization_id, 'member')
);

-- UPDATE: admins/owners ou criador
CREATE POLICY "<table>_update" ON public.<table>
FOR UPDATE TO authenticated
USING (
  public.has_role(organization_id, 'admin')
  OR created_by = auth.uid()
)
WITH CHECK (
  public.is_member(organization_id)
  -- Garantir que não muda de tenant:
  -- organization_id = (SELECT t.organization_id FROM public.<table> t WHERE t.id = <table>.id)
);

-- DELETE: só admins/owners (preferir soft-delete)
CREATE POLICY "<table>_delete" ON public.<table>
FOR DELETE TO authenticated
USING (public.has_role(organization_id, 'admin'));
```

## Indexação obrigatória em multi-tenant

Para qualquer tabela `t` de tenant:

```sql
-- 1. Index principal pelo tenant (suporta toda a policy)
CREATE INDEX idx_t_org ON public.t(organization_id);

-- 2. Listing por tenant ordenado por data
CREATE INDEX idx_t_org_created ON public.t(organization_id, created_at DESC);

-- 3. Se há soft-delete, partial index para queries ativas
CREATE INDEX idx_t_org_alive ON public.t(organization_id, created_at DESC)
WHERE deleted_at IS NULL;

-- 4. FK a outras tabelas — sempre composto começando por org se possível
CREATE INDEX idx_t_org_project ON public.t(organization_id, project_id);
```

## Onboarding flow (membership atómico)

Quando um user cria uma organização, ela tem de ficar com **membership owner** dele atomicamente. Caso contrário fica órfã.

```sql
CREATE OR REPLACE FUNCTION public.create_organization(org_name text, org_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  new_org_id uuid;
  current_user_id uuid := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, org_slug)
  RETURNING id INTO new_org_id;

  INSERT INTO public.memberships (organization_id, user_id, role)
  VALUES (new_org_id, current_user_id, 'owner');

  RETURN new_org_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_organization(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_organization(text, text) TO authenticated;
```

Cliente:
```ts
const { data: orgId } = await supabase.rpc('create_organization', {
  org_name: 'Acme', org_slug: 'acme'
})
```

## JWT claims com organização ativa

Padrão avançado: armazenar `current_organization_id` no JWT do utilizador para evitar passar a org em cada query.

Implementação via Custom Access Token Hook (Supabase Auth Hooks):

```sql
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE
AS $$
DECLARE
  claims jsonb;
  user_org uuid;
BEGIN
  -- Buscar a org "default" do user (última usada ou primeira)
  SELECT organization_id INTO user_org
  FROM public.memberships
  WHERE user_id = (event->>'user_id')::uuid AND is_active = true
  ORDER BY joined_at DESC
  LIMIT 1;

  claims := event->'claims';
  IF user_org IS NOT NULL THEN
    claims := jsonb_set(claims, '{app_metadata,current_org}', to_jsonb(user_org));
  END IF;
  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;
```

E configurar no Dashboard: Auth → Hooks → Custom Access Token.

Depois nas policies podes usar:
```sql
USING (organization_id = (auth.jwt() -> 'app_metadata' ->> 'current_org')::uuid)
```

Vantagem: dispensa o helper `is_member` (mais rápido). Desvantagem: o user precisa de logout/login para mudar de org, ou ter mecanismo de refresh.

## Storage multi-tenant

Buckets partilhados, paths prefixados com `organization_id`:

```
documents/
  <org_uuid_A>/
    <user_uuid>/
      file1.pdf
  <org_uuid_B>/
    ...
```

Policy:
```sql
CREATE POLICY "documents_bucket_read" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'documents'
  AND public.is_member(((storage.foldername(name))[1])::uuid)
);

CREATE POLICY "documents_bucket_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND public.is_member(((storage.foldername(name))[1])::uuid)
  AND (storage.foldername(name))[2] = auth.uid()::text
);
```

## Realtime multi-tenant

Cliente subscribe com filtro:
```ts
supabase.channel(`tasks:${orgId}`)
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'tasks', filter: `organization_id=eq.${orgId}` },
    handler
  )
  .subscribe()
```

E activar realtime apenas em tabelas estritamente necessárias:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
```

## Tabelas que **não** devem ter `organization_id`

- `auth.users` — gerida pelo Supabase Auth
- `public.profiles` (mapping 1:1 com auth.users) — pertencem ao user
- `public.memberships` — é o próprio join
- Tabelas globais (countries, currencies, plans) — sem RLS ou apenas SELECT público

## Anti-patterns multi-tenant

### A1. Tenant inferido apenas via JOIN
```sql
-- ERRADO: policy faz JOIN em cada check
USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = tasks.project_id
      AND p.organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid())
  )
)
```
Lento. Difícil de auditar. Risco de drift se `project_id` mudar.

**Correto**: denormalizar `organization_id` e usar policy direta.

### A2. `tenant_id` mutável
Permitir UPDATE de `organization_id` é uma porta para mover dados entre tenants por engano (ou maliciosamente).

```sql
-- WITH CHECK que impede mudança de tenant
CREATE POLICY "no_tenant_change" ON public.documents
FOR UPDATE TO authenticated
USING (public.is_member(organization_id))
WITH CHECK (
  public.is_member(organization_id)
  AND organization_id = (SELECT d.organization_id FROM public.documents d WHERE d.id = documents.id)
);
```

Ou trigger:
```sql
CREATE OR REPLACE FUNCTION public.prevent_tenant_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;
```

### A3. Slugs globais únicos vs por-tenant
```sql
slug text UNIQUE -- conflito entre tenants
slug text, UNIQUE (organization_id, slug)  -- correto para slugs por-tenant
```

### A4. Service role para "simplificar" em vez de policies
"O backend usa service_role então não precisa de RLS". **Falso**. RLS é defesa em profundidade. Se um endpoint backend tiver bug de autorização, RLS limita o blast.

## Checklist multi-tenant

- [ ] `organizations`, `memberships` (com role enum), `invitations` existem
- [ ] Toda tabela de tenant tem `organization_id NOT NULL` com FK
- [ ] Helpers `is_member`, `has_role` criados, com `SECURITY DEFINER` e `search_path` fixo
- [ ] Todas as policies usam o helper, não inline subqueries
- [ ] Indexes começam por `organization_id`
- [ ] `created_organization` RPC cria org + membership atomicamente
- [ ] Trigger ou WITH CHECK previne mudança de `organization_id`
- [ ] Storage paths com `organization_id` no prefixo + policies path-based
- [ ] Realtime subscriptions com `filter: organization_id=eq.<id>`
- [ ] Edge Functions validam membership antes de operar sobre dados de tenant
