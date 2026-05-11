# Template — SUPABASE_ARCHITECTURE.md

Estrutura fixa para documentar arquitetura de schema (design ou auditoria).

---

```markdown
# SUPABASE_ARCHITECTURE — <project_name>

> Documento de arquitetura da base de dados.
> Gerado por **Supabase Architect** em <YYYY-MM-DD>.

## 1. Modelo de negócio

- **Tipo**: <SaaS B2B | SaaS B2C | CRM | Marketplace | Hotel system | LMS | Internal tool>
- **Modelo de tenancy**: <user-as-tenant | organization-as-tenant | hierarchical>
- **Personas**: <Owner | Admin | Member | Viewer | End-customer>

## 2. Domínios

### 2.1 Identity & Tenancy
- `auth.users` — Supabase Auth (não modificada)
- `public.profiles` — 1:1 com `auth.users`, dados de perfil
- `public.organizations` — tenants
- `public.memberships` — N:M users ↔ organizations com role
- `public.invitations` — convites pendentes

### 2.2 <Domínio de negócio 1>
- `public.<tabela>` — descrição
- …

### 2.3 <Domínio de negócio 2>
…

### 2.4 Operations
- `public.audit_logs` — log de operações sensíveis
- `public.rate_limits` — rate limiting per-key

## 3. Diagrama lógico

```
auth.users ──1:1── public.profiles
    │
    │N:M (via memberships)
    │
public.organizations ──1:N── public.<entidade>
    │                              │
    │                              ├── public.<sub_entidade> (org_id denormalizado)
    │                              │
    │                              └── storage.objects (bucket=<X>, path=<org>/<user>/<file>)
    │
    └── audit_logs (per-org)
```

## 4. Convenções

- **IDs**: `uuid` com `gen_random_uuid()`
- **Timestamps**: `timestamptz`
- **Soft-delete**: `deleted_at timestamptz NULL`
- **Tenant**: `organization_id uuid NOT NULL` denormalizado em todas as tabelas de tenant
- **Auditoria**: `created_at`, `updated_at` automáticos via trigger; `created_by uuid` quando aplicável
- **Enums** para vocabulário fechado
- **JSON**: `jsonb NOT NULL DEFAULT '{}'`

## 5. Schema completo

### 5.1 Schema base (organizations, memberships)

```sql
CREATE TYPE public.member_role AS ENUM ('owner','admin','member','viewer');

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.memberships (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  is_active boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_memberships_user_active
  ON public.memberships(user_id) WHERE is_active = true;
CREATE INDEX idx_memberships_org_role
  ON public.memberships(organization_id, role);
```

### 5.2 Helpers

```sql
-- public.is_member, public.has_role, public.role_in, public.set_updated_at
-- ver SUPABASE_RLS.md
```

### 5.3 Entidades de domínio

```sql
CREATE TABLE public.<entity> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  -- campos de negócio
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_<entity>_org_alive
  ON public.<entity>(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE public.<entity> ENABLE ROW LEVEL SECURITY;
-- + policies (SUPABASE_RLS.md)
```

### 5.4 Storage

| Bucket | Público | Estrutura de path | Propósito |
|---|---|---|---|
| avatars | sim | `<user_id>/avatar.*` | Avatar público |
| documents | não | `<org_id>/<user_id>/<file>` | Documentos da org |

Policies em `storage.objects`: ver `SUPABASE_SECURITY.md`.

### 5.5 Realtime

Tabelas em `supabase_realtime`:
- `public.messages` — chat
- `public.notifications` — notifications per-user

## 6. Decisões arquiteturais (ADRs)

### ADR-001: Modelo de tenancy — organization-as-tenant
- **Contexto**: SaaS B2B com utilizadores em múltiplas organizações.
- **Decisão**: `organizations` + `memberships` com role enum.
- **Alternativas consideradas**: workspace-per-user (rejeitado — dificulta convidar múltiplos).
- **Consequências**: cada tabela de tenant denormaliza `organization_id`.

### ADR-002: PKs uuid
- **Decisão**: `uuid` para todas as PKs públicas em API.
- **Razão**: não-enumeráveis, distribuíveis.
- **Exceção**: `audit_logs.id` é `bigint` (alto volume, não exposto em API).

### ADR-003: Soft-delete em vez de DELETE
- **Decisão**: tabelas de domínio têm `deleted_at`.
- **Razão**: undo, audit, restore.
- **Aplicação**: policies SELECT filtram `WHERE deleted_at IS NULL`.

### ADR-004: Multi-tenant via RLS + denormalização
- **Decisão**: cada tabela tem `organization_id` (mesmo quando derivável), policies usam helpers `SECURITY DEFINER STABLE`.
- **Razão**: performance — evita JOIN em cada policy check.
- **Alternativa**: schema-per-tenant (rejeitada — gestão complexa, custo de migrations).

## 7. Crescimento e escala

### 7.1 Volume esperado (12 meses)
| Tabela | Linhas | Notas |
|---|---|---|
| public.<entity> | ~10M | Index `(org_id, created_at DESC)` crítico |

### 7.2 Pontos de escala já considerados
- Indexes compostos começam por `organization_id` (poda 99% das linhas em queries multi-tenant)
- Materialized views para dashboards
- Particionamento futuro por `organization_id` (não implementado ainda)

### 7.3 Pontos de pressão futura
- `audit_logs` cresce indefinidamente → necessário retention policy aos 12-24 meses de dados
- Realtime em `messages` se atingir N msgs/s — considerar shardar canais

## 8. Operações

### 8.1 Migrações
- Versionadas em `supabase/migrations/`
- Comando: `supabase migration new <name>`, depois `supabase db push`
- Cada migração: comentário com risk + rollback

### 8.2 Backups
- Supabase platform backups: diários
- Plano: PITR (Point-in-Time Recovery) — RPO < 1 min

### 8.3 Monitoring
- Supabase Dashboard → Reports
- Alertas em CPU, IOPS, conexões
- Métrica custom: % de queries acima de 100ms

## 9. Próximos passos

- [ ] <itens não cobertos pelo design atual>
```
