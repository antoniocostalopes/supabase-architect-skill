# Schema Patterns para Supabase

Convenções e padrões de design de schema para projetos Supabase profissionais.

## Convenções base

### Naming
- **Tabelas**: `snake_case`, plural (`users`, `orders`, `documents`)
- **Colunas**: `snake_case`, singular (`user_id`, `created_at`)
- **PK**: `id uuid` (default), ou `id bigint generated always as identity` em alto volume
- **FKs**: `<entidade>_id` (`user_id`, `organization_id`)
- **Indexes**: `idx_<tabela>_<colunas>` (`idx_orders_org_created`)
- **Constraints**: `<tabela>_<col>_<tipo>` (`orders_amount_check`)
- **Enums**: `<entidade>_<atributo>` (`member_role`, `order_status`)
- **Functions**: `<verbo>_<objeto>` (`create_organization`, `is_member`)
- **Triggers**: `trg_<tabela>_<ação>` (`trg_orders_updated_at`)

### Tipos preferidos
- **IDs**: `uuid` com `DEFAULT gen_random_uuid()` — não-enumeráveis, distributable
- **Timestamps**: `timestamptz` (timezone-aware), nunca `timestamp` sem TZ
- **Texto**: `text` (não `varchar(N)` salvo CHECK explícito)
- **Dinheiro**: `numeric(12,2)` ou `bigint` (cents) — nunca `float`/`double`
- **JSON**: `jsonb` (não `json`) — indexável, mais rápido
- **Booleanos**: `boolean NOT NULL DEFAULT false` (não nullable)
- **Enums**: `CREATE TYPE` + uso como tipo, melhor que `text CHECK (... IN (...))`

## Tabela base (template)

```sql
CREATE TABLE public.<entity> (
  -- Identidade
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant (se multi-tenant)
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Ownership
  created_by uuid NOT NULL REFERENCES auth.users(id),

  -- Campos de negócio
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  -- Constraints
  CONSTRAINT <entity>_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT <entity>_status_valid CHECK (status IN ('active','archived','deleted'))
);

-- Indexes obrigatórios
CREATE INDEX idx_<entity>_org_alive
  ON public.<entity>(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_<entity>_creator ON public.<entity>(created_by);

-- Trigger updated_at
CREATE TRIGGER trg_<entity>_updated_at
BEFORE UPDATE ON public.<entity>
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.<entity> ENABLE ROW LEVEL SECURITY;
-- + policies (ver 01-rls-patterns.md)

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<entity> TO authenticated;

-- Realtime (opcional)
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.<entity>;
```

## Helper functions reutilizáveis

```sql
-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Soft delete trigger (preferir UPDATE manual; trigger é controverso)
CREATE OR REPLACE FUNCTION public.soft_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Intercepta DELETE e converte em UPDATE deleted_at
  EXECUTE format('UPDATE %I.%I SET deleted_at = now() WHERE id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
  USING OLD.id;
  RETURN NULL;
END;
$$;

-- Tenant immutable trigger
CREATE OR REPLACE FUNCTION public.prevent_tenant_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable on %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
```

## Padrão organizations + memberships

Já documentado em `02-multi-tenant-patterns.md`. Resumo:

```sql
CREATE TYPE public.member_role AS ENUM ('owner','admin','member','viewer');

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  is_active boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
```

## Padrão audit log

Para operações sensíveis (deletes, mudanças de role, alterações de billing):

```sql
CREATE TABLE public.audit_logs (
  id bigint generated always as identity PRIMARY KEY,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  action text NOT NULL,           -- 'membership.role_changed', 'document.deleted'
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_org_time ON public.audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX idx_audit_logs_resource ON public.audit_logs(resource_type, resource_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Só admins veem audit; ninguém escreve via cliente
CREATE POLICY "audit_select_admin" ON public.audit_logs
FOR SELECT TO authenticated
USING (public.has_role(organization_id, 'admin'));
-- INSERT só via service_role (RLS bloqueia authenticated)
```

## Padrão enum bem definido

```sql
-- Em vez de:
-- status text CHECK (status IN ('a','b','c'))

-- Preferir:
CREATE TYPE public.order_status AS ENUM ('pending','paid','shipped','cancelled','refunded');

CREATE TABLE public.orders (
  ...
  status public.order_status NOT NULL DEFAULT 'pending',
  ...
);

-- Adicionar novo valor depois (não-destrutivo):
ALTER TYPE public.order_status ADD VALUE 'returned' AFTER 'refunded';

-- Reordenar / renomear requer recriação cuidadosa
```

## Padrão JSONB com schema soft

Para campos com estrutura mas evolutivos:

```sql
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Validar shape via CHECK + função:
  CONSTRAINT events_payload_valid CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX idx_events_type_time ON public.events(organization_id, type, occurred_at DESC);
CREATE INDEX idx_events_payload_gin ON public.events USING gin (payload);

-- Para validação por type (extensível):
CREATE OR REPLACE FUNCTION public.validate_event_payload(event_type text, payload jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  CASE event_type
    WHEN 'order.created' THEN
      RETURN payload ? 'order_id' AND payload ? 'amount';
    WHEN 'user.signed_up' THEN
      RETURN payload ? 'user_id';
    ELSE
      RETURN true;
  END CASE;
END;
$$;

ALTER TABLE public.events ADD CONSTRAINT events_payload_shape
  CHECK (public.validate_event_payload(type, payload));
```

## Padrão polymorphic (com cuidado)

Caso: comments podem ser em `posts`, `documents`, `tasks`.

Opção A (recomendada): tabelas separadas (`post_comments`, `document_comments`).

Opção B (polymorphic com check):
```sql
CREATE TABLE public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  parent_type text NOT NULL CHECK (parent_type IN ('post','document','task')),
  parent_id uuid NOT NULL,
  body text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sem FK direta (parent_id pode apontar para várias tabelas)
-- Validação via trigger se necessário
CREATE INDEX idx_comments_parent ON public.comments(parent_type, parent_id);
```

Trade-off: perde integridade referencial automática. Ganha flexibilidade.

## Padrão history / versioning

Para entidades que precisam de auditoria de mudanças:

```sql
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  version int NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  changed_by uuid NOT NULL REFERENCES auth.users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE OR REPLACE FUNCTION public.snapshot_document_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (OLD.title, OLD.content) IS DISTINCT FROM (NEW.title, NEW.content) THEN
    INSERT INTO public.document_versions
      (document_id, organization_id, version, title, content, changed_by)
    VALUES
      (OLD.id, OLD.organization_id, OLD.version, OLD.title, OLD.content, auth.uid());
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_documents_version
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.snapshot_document_version();
```

## Padrão computed columns / generated

```sql
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subtotal numeric(12,2) NOT NULL,
  tax_rate numeric(5,4) NOT NULL DEFAULT 0.23,
  total numeric(12,2) GENERATED ALWAYS AS (subtotal * (1 + tax_rate)) STORED,
  ...
);
```

Vantagem: cliente nunca pode escrever `total` errado.

## Padrão search / FTS

```sql
ALTER TABLE public.posts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(body,'')), 'B')
  ) STORED;

CREATE INDEX idx_posts_search ON public.posts USING gin (search_vector);

-- Query
SELECT id, title, ts_rank(search_vector, query) AS rank
FROM public.posts, websearch_to_tsquery('portuguese', 'palavra chave') query
WHERE search_vector @@ query
ORDER BY rank DESC LIMIT 20;
```

## Padrão geographic / PostGIS

Se vais usar coordenadas:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE public.places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location geography(Point, 4326) NOT NULL
);

CREATE INDEX idx_places_location ON public.places USING gist (location);

-- Encontrar dentro de 5km
SELECT * FROM public.places
WHERE ST_DWithin(location, ST_MakePoint(-9.139, 38.722)::geography, 5000);
```

## Anti-patterns de schema

### A1. Boolean nullable
```sql
is_active boolean  -- pode ser NULL, lógica boolean explode
```
Sempre `NOT NULL DEFAULT false` (ou true).

### A2. Float para dinheiro
```sql
price float  -- 0.1 + 0.2 != 0.3 em float
```
Usar `numeric(12,2)` ou `bigint` (cents).

### A3. timestamp sem timezone
```sql
created_at timestamp  -- ambíguo, perde TZ
```
Sempre `timestamptz`.

### A4. text CHECK em vez de enum
Manter `CHECK (status IN (...))` espalha definição. Enum centraliza.

### A5. PK auto-increment exposta
```sql
id serial PRIMARY KEY  -- 1, 2, 3 → enumerable em URLs
```
Preferir `uuid` para PKs visíveis em API/URLs.

### A6. FK sem `ON DELETE`
Default é `NO ACTION`. Pensar explicitamente:
- `CASCADE` — apaga filhos
- `SET NULL` — orfan os filhos
- `RESTRICT` — bloqueia delete do pai

### A7. Esquecer index composto e criar dois separados
Para query `WHERE org_id = X AND created_at > Y`, ter index `(org_id)` + `(created_at)` é pior que `(org_id, created_at DESC)`.

### A8. Comments em colunas críticas? Sim
```sql
COMMENT ON COLUMN public.users.tier IS 'Stripe tier: free|pro|enterprise. Updated by Stripe webhook handler.';
```

Documenta a intenção da coluna, especialmente quando há lógica externa.
