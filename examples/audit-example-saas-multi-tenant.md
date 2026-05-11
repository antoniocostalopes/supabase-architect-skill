# Example — SUPABASE_AUDIT.md (SaaS B2B Multi-Tenant)

Exemplo few-shot do output gerado para um SaaS B2B com Next.js + Supabase. Usa este formato/tom como referência.

---

```markdown
# SUPABASE_AUDIT — acme-crm

> Auditoria gerada por **Supabase Architect** em 2026-05-11.
> Stack detectado: Next.js 14 (App Router) · Supabase project: `xyzabc123`.
> Escopo: toda a base.

## Sumário executivo

- **Score de readiness**: 42 / 100 — Pre-produção (refactor necessário)
- **Críticos**: 4
- **Altos**: 7
- **Médios**: 11
- **Baixos**: 5

**Top 3 ações urgentes**:
1. Rotar `SUPABASE_SERVICE_ROLE_KEY` (exposto em `NEXT_PUBLIC_*`) e remover do bundle do browser.
2. Activar RLS em `public.deals`, `public.contacts`, `public.activities` (3 tabelas Críticas sem proteção).
3. Tornar bucket `attachments` privado — atualmente público com PII de clientes.

## Mapa do projeto

### Tabelas em `public.*`
| Tabela | RLS | Policies | Linhas (aprox) | Tenant model |
|---|---|---|---|---|
| organizations | true | 4 | 312 | raiz |
| memberships | true | 3 | 1.2k | join |
| profiles | true | 2 | 1.4k | user-owned |
| deals | **false** ⚠ | 0 | 84k | org-owned |
| contacts | **false** ⚠ | 0 | 220k | org-owned |
| activities | **false** ⚠ | 0 | 1.1M | org-owned |
| pipelines | true | 4 | 980 | org-owned |
| stages | true | 4 | 6.5k | org-owned |
| audit_logs | true | 1 | 4.2M | org-owned |

### Edge Functions
| Função | Auth check | service_role | Notas |
|---|---|---|---|
| stripe-webhook | signature | sim | OK |
| send-invite | **❌** | sim | **Crítico — anónimo** |
| export-deals | parcial | sim | Alto — não valida org membership |

### Storage buckets
| Bucket | Público | Policies | Path strategy |
|---|---|---|---|
| avatars | sim | 3 | `<user_id>/avatar.*` — OK |
| attachments | **sim** ⚠ | 1 | sem prefixo de tenant — **Crítico** |

### Realtime
| Tabela | Replica identity | Notas |
|---|---|---|
| activities | full | escrita alta — custo elevado |
| audit_logs | full | **remover — só para historial** |

## Achados por capacidade

### 1. RLS

#### [CRÍTICO · 95%] RLS missing em `public.deals`
- **Localização**: `supabase/migrations/20251210090000_deals.sql:14`
- **Problema**: Tabela contém todos os deals/oportunidades de todos os tenants. `rowsecurity = false` em `pg_tables`. Qualquer cliente com a anon key pode `SELECT * FROM deals` via PostgREST.
- **Impacto arquitetural**: Exposição completa do pipeline comercial de todos os tenants. Inclui valores, contactos, notas internas.
- **Correção**:
  ```sql
  ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "deals_select" ON public.deals
  FOR SELECT TO authenticated
  USING (public.is_member(organization_id) AND deleted_at IS NULL);

  CREATE POLICY "deals_insert" ON public.deals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(organization_id, 'member')
    AND created_by = auth.uid()
  );

  CREATE POLICY "deals_update" ON public.deals
  FOR UPDATE TO authenticated
  USING (
    deleted_at IS NULL
    AND (public.has_role(organization_id, 'admin') OR created_by = auth.uid())
  )
  WITH CHECK (public.is_member(organization_id));

  CREATE POLICY "deals_delete" ON public.deals
  FOR DELETE TO authenticated
  USING (public.has_role(organization_id, 'admin'));

  -- Index a suportar
  CREATE INDEX IF NOT EXISTS idx_deals_org_alive
    ON public.deals(organization_id, created_at DESC)
    WHERE deleted_at IS NULL;
  ```
- **Rollback**: `ALTER TABLE public.deals DISABLE ROW LEVEL SECURITY;` (não recomendado).

#### [CRÍTICO · 95%] RLS missing em `public.contacts`
Idem para `deals`. Ver fix análogo acima, substituindo `deals` por `contacts`.

#### [CRÍTICO · 95%] RLS missing em `public.activities`
Idem.

#### [ALTO · 90%] Policy sem filtro de tenant em `public.pipelines`
- **Localização**: `pg_policies` → `pipelines_select`
- **Problema actual**:
  ```sql
  CREATE POLICY "pipelines_select" ON public.pipelines
  FOR SELECT TO authenticated USING (created_by = auth.uid());
  ```
- **Impacto**: User criador vê os seus pipelines, mas outros membros da mesma org não veem. Pior: se duas orgs tiverem o mesmo user como criador, mistura dados via histórico/admin.
- **Correção**:
  ```sql
  DROP POLICY "pipelines_select" ON public.pipelines;
  CREATE POLICY "pipelines_select" ON public.pipelines
  FOR SELECT TO authenticated
  USING (public.is_member(organization_id));
  ```

### 2. Auth

#### [CRÍTICO · 95%] `service_role` exposto no bundle
- **Localização**: `.env.local:9`, `src/lib/supabase.ts:18`
- **Problema**: `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` está prefixada com `NEXT_PUBLIC_` — incluída no JS do browser.
- **Verificação**:
  ```bash
  grep -r "SERVICE_ROLE" src/ public/ app/ --include="*.{ts,tsx,js}"
  # Resultado: src/lib/supabase.ts:18 references NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
  ```
- **Correção** (urgente, 1h):
  1. Rotar key em Supabase Dashboard → Settings → API → Reset service_role key
  2. Em `.env.local`, renomear:
     ```
     SUPABASE_SERVICE_ROLE_KEY=<nova-key>
     ```
     (sem `NEXT_PUBLIC_`)
  3. Criar `src/lib/supabase-admin.ts` (server-only):
     ```ts
     import 'server-only'
     import { createClient } from '@supabase/supabase-js'
     export const supabaseAdmin = createClient(
       process.env.SUPABASE_URL!,
       process.env.SUPABASE_SERVICE_ROLE_KEY!,
       { auth: { persistSession: false } }
     )
     ```
  4. Mover `src/lib/supabase.ts` para apenas anon key.
  5. Auditar logs do Supabase (Dashboard → Logs) por accesses anómalos nas últimas semanas.

#### [ALTO · 85%] `getSession()` em SSR
- **Localização**: `middleware.ts:23`, `app/dashboard/layout.tsx:8`
- **Problema**: `getSession()` apenas lê o cookie; não revalida contra o servidor. Um cookie forjado passa.
- **Correção**:
  ```ts
  // Antes
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return redirect('/login')

  // Depois
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')
  ```

### 3. Storage

#### [CRÍTICO · 95%] Bucket `attachments` público com PII
- **Localização**: `storage.buckets` → `attachments.public = true`
- **Problema**: Contratos PDF e screenshots de cards estão num bucket público. Filenames são `<deal_id>-<filename>.pdf` — previsíveis.
- **Correção**:
  ```sql
  UPDATE storage.buckets SET public = false WHERE id = 'attachments';

  -- Adicionar policies
  CREATE POLICY "attachments_read_org" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'attachments'
    AND public.is_member(((storage.foldername(name))[1])::uuid)
  );
  -- + INSERT, DELETE
  ```
- **Refactor cliente**: substituir `getPublicUrl` por `createSignedUrl` em `src/components/AttachmentLink.tsx`.
- **Migrar estrutura existente**: atualizar paths para `<org_id>/<deal_id>/<file>` (script migração separado).

### 4. Migrations

#### [ALTO · 90%] Migração `20260205_add_deal_status.sql` adiciona NOT NULL sem default
```sql
ALTER TABLE public.deals ADD COLUMN status text NOT NULL;
-- Falha em produção: tabela tem 84k linhas sem valor.
```
- **Correção** (split em 3 migrações):
  1. `20260205_a_add_status_nullable.sql`: `ADD COLUMN status text;`
  2. Backfill em batches (DML separado)
  3. `20260205_b_enforce_status.sql`: `ALTER COLUMN status SET NOT NULL; SET DEFAULT 'open';`

### 5. Performance

#### [ALTO · 90%] FK `activities.deal_id` sem index
- **Problema**: 1.1M linhas, FK sem index. DELETE/UPDATE em `deals` causa seq scan.
- **Correção**:
  ```sql
  CREATE INDEX CONCURRENTLY idx_activities_deal_id ON public.activities(deal_id);
  ```

#### [MÉDIO · 80%] Realtime em `audit_logs` (4.2M linhas, write-heavy)
- **Correção**:
  ```sql
  ALTER PUBLICATION supabase_realtime DROP TABLE public.audit_logs;
  ```

### 6. Edge Functions

#### [CRÍTICO · 95%] `send-invite` sem auth check
- **Problema**: Endpoint aceita qualquer caller; insere row em `invitations` e envia email em nome de qualquer org.
- **Correção**: aplicar skeleton de `08-edge-functions-security.md` — validar `Authorization`, fazer `getUser()`, validar membership na org alvo, só então inserir e enviar email.

## Attack chains

### Chain 1 — Exfiltração total via service_role
1. **Achado 2.1** (Crítico): `service_role` no bundle.
2. **Achado 1.1–1.3** (Crítico): tabelas críticas sem RLS — não há defesa em profundidade.
3. **Resultado**: atacante extrai service_role do view-source → `SELECT *` directo a `deals`, `contacts`, `activities`. Exfiltração total em segundos.

### Chain 2 — Cross-tenant via invitation forjada
1. **Achado 6.1** (Crítico): `send-invite` anónimo.
2. **Achado 1.4** (Alto): policy de `memberships_insert` confia em `organization_id` do payload sem validar.
3. **Resultado**: atacante chama `send-invite` com `org_id` de outro tenant + email próprio → aceita o invite → torna-se admin de uma org alheia.

## Plano de correção (4 fases)

### Fase 1 — Stop the bleeding (24h)
- [ ] Rotar service_role key + remover do bundle
- [ ] Activar RLS em `deals`, `contacts`, `activities`
- [ ] Tornar bucket `attachments` privado
- [ ] Bloquear ou patchar Edge Function `send-invite`

### Fase 2 — Estrutural (1-2 semanas)
- [ ] Refactor de policies multi-tenant via helpers `is_member`/`has_role`
- [ ] Criar `public.is_member()` + `public.has_role()` (faltam)
- [ ] Index em FKs sem index (lista no Apêndice A)
- [ ] Substituir `getSession()` por `getUser()` em todos os SSR
- [ ] Migrar paths de `attachments` para `<org_id>/<deal_id>/<file>`

### Fase 3 — Optimização (2-4 semanas)
- [ ] Remover `audit_logs` do realtime
- [ ] Materialized view para dashboard agregado de deals
- [ ] Cursor pagination em listing de deals/contacts
- [ ] Partial indexes para `WHERE deleted_at IS NULL`

### Fase 4 — Operacional (contínuo)
- [ ] CI a correr `supabase db diff` para detectar drift
- [ ] Pre-commit a verificar RLS coverage
- [ ] Test restore de backup
- [ ] Alertas no Dashboard (CPU, conexões, latência)

## Apêndice A — FKs sem index
| Tabela | Coluna FK | Comando |
|---|---|---|
| activities | deal_id | `CREATE INDEX CONCURRENTLY idx_activities_deal_id ON public.activities(deal_id);` |
| activities | contact_id | `CREATE INDEX CONCURRENTLY idx_activities_contact_id ON public.activities(contact_id);` |
| stages | pipeline_id | `CREATE INDEX CONCURRENTLY idx_stages_pipeline_id ON public.stages(pipeline_id);` |

## Apêndice B — Queries de re-verificação
(ver `references/09-production-checklist.md` — secção "Queries de auditoria automatizada")

## Apêndice C — Checklist final
(ver `references/09-production-checklist.md` — secções A–K)
```

---

## Notas de estilo (para a IA)

- Tom: técnico, direto, sem alarmismo.
- Cita sempre ficheiro/linha ou schema.tabela.
- Cada SQL é copy-paste — não pseudo-SQL.
- Cada achado tem confidence (95%/80%/60%).
- Achados <40% confidence são descartados — não inflar o relatório.
- Attack chains mostram impacto real, não cenários teóricos.
- Plano de correção em fases temporais concretas.
