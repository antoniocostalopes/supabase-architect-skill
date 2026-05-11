# Template — SUPABASE_AUDIT.md

Estrutura fixa para o relatório de auditoria completo. Usa **literalmente** este template.

---

```markdown
# SUPABASE_AUDIT — <project_name>

> Auditoria gerada por **Supabase Architect** em <YYYY-MM-DD>.
> Stack detectado: <Next.js | Remix | SvelteKit | Expo | etc.> · Supabase project: <ref>.
> Escopo: <toda a base | módulo X | tabela Y>.

## Sumário executivo

- **Score de readiness**: <0–100> / 100 — <nível>
- **Críticos**: <n>
- **Altos**: <n>
- **Médios**: <n>
- **Baixos**: <n>

**Top 3 ações urgentes**:
1. <ação 1>
2. <ação 2>
3. <ação 3>

## Mapa do projeto

### Tabelas relevantes
| Tabela | RLS | Policies | Linhas (aprox) | Tenant |
|---|---|---|---|---|
| public.organizations | true | 4 | … | raiz |
| public.documents | **false** ⚠ | 0 | … | org-owned |
| … | | | | |

### Edge Functions
| Função | Auth check | Service_role | Notas |
|---|---|---|---|
| create-order | ✅ | após validação | OK |
| stripe-webhook | signature | sim | OK |

### Storage buckets
| Bucket | Público | Policies | Path strategy |
|---|---|---|---|
| documents | privado | 4 | `<org>/<user>/<file>` |
| avatars | público | 3 | `<user>/<file>` |

### Realtime
| Tabela | Replica identity | Notas |
|---|---|---|
| public.messages | default | OK |
| public.audit_logs | default | ⚠ remover |

## Achados por capacidade

### 1. RLS

#### [CRÍTICO · 95%] RLS missing em `public.documents`
- **Categoria**: RLS
- **Localização**: `supabase/migrations/20260103_documents.sql:12`
- **Problema**: Tabela `public.documents` não tem RLS ativada. Qualquer cliente com a anon key pode `SELECT *`.
- **Impacto arquitetural**: Exposição total de dados de tenants via REST/PostgREST.
- **SQL atual**:
  ```sql
  CREATE TABLE public.documents (...);
  GRANT SELECT ON public.documents TO authenticated;
  ```
- **Correção**:
  ```sql
  ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "documents_select" ON public.documents
  FOR SELECT TO authenticated
  USING (public.is_member(organization_id) AND deleted_at IS NULL);
  -- + INSERT, UPDATE, DELETE (ver SUPABASE_RLS.md)
  ```
- **Rollback**: `ALTER TABLE public.documents DISABLE ROW LEVEL SECURITY;`

#### [ALTO · 80%] Policy sem filtro de tenant em `public.invoices`
…

### 2. Auth

#### [CRÍTICO · 95%] `service_role` exposto em bundle do cliente
- **Categoria**: Auth / Secrets
- **Localização**: `.env.local:7`, `src/lib/supabase.ts:12`
- **Problema**: `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` aparece com prefixo público.
- **Impacto**: Qualquer visitante lê a key via view-source. Bypass total de RLS.
- **Correção**:
  1. Rotar a key em Supabase Dashboard → Settings → API.
  2. Renomear em `.env.local`: `SUPABASE_SERVICE_ROLE_KEY=...` (sem `NEXT_PUBLIC_`).
  3. Mover `src/lib/supabase.ts` para usar apenas anon no cliente; mover usos de service_role para `src/lib/supabase-admin.ts` (server-only).
  4. Auditar logs do Supabase por acesso suspeito.

### 3. Storage
…

### 4. Migrations
…

### 5. Performance
…

### 6. Realtime
…

### 7. Edge Functions
…

### 8. Multi-tenant isolation
…

### 9. Production readiness
…

### 10. Schema quality
…

## Attack chains

Cadeias de problemas que combinam:

### Chain 1 — Exfiltração total via service_role + bucket público
1. Service_role exposto (achado 2.1)
2. Bucket `documents` público com PII (achado 3.2)
3. Resultado: atacante obtém service_role do view-source → consulta `documents` → constrói URLs públicos → exfiltra.

### Chain 2 — Cross-tenant via policy fraca + realtime sem filtro
1. Policy em `tasks` sem `organization_id` (achado 1.3)
2. Realtime subscription sem filtro (achado 6.1)
3. Resultado: user da Org A subscreve `tasks` e recebe events da Org B até RLS bloquear payload (mas timing leak persiste).

## Plano de correção (4 fases)

### Fase 1 — Stop the bleeding (24h)
- [ ] Rotar service_role key
- [ ] Activar RLS em `public.documents`, `public.invoices`
- [ ] Tornar bucket `documents` privado

### Fase 2 — Estrutural (1 semana)
- [ ] Refactor de policies multi-tenant via helpers `is_member`/`has_role`
- [ ] Indexes em FKs sem index (lista no apêndice A)
- [ ] Migrar service_role do cliente para Edge Functions

### Fase 3 — Optimização (2-4 semanas)
- [ ] Partial indexes para soft-delete
- [ ] Cursor pagination nos listings principais
- [ ] Materialized views para dashboards

### Fase 4 — Operacional (contínuo)
- [ ] CI a correr `supabase db diff` para detectar drift
- [ ] Pre-commit a verificar RLS coverage
- [ ] Backups testados (restore drill mensal)

## Apêndice A — FKs sem index
| Tabela | Coluna FK | Comando |
|---|---|---|
| comments | post_id | `CREATE INDEX CONCURRENTLY idx_comments_post_id ON public.comments(post_id);` |
| … | | |

## Apêndice B — Queries de re-verificação
Anexar as queries da secção "Queries de auditoria automatizada" de [`09-production-checklist.md`](../references/09-production-checklist.md).

## Apêndice C — Checklist final
Anexar [`09-production-checklist.md`](../references/09-production-checklist.md) marcado conforme estado atual.
```

---

## Como calcular o score

```
Score base: 100
- Crítico: -15 cada (até 5; depois -20)
- Alto: -7 cada
- Médio: -3 cada
- Baixo: -1 cada
Bonus:
+5 se nenhum service_role exposto
+5 se RLS coverage = 100%
+5 se todas as FKs têm index
+3 se migrações têm rollback documentado
+2 se há monitoring configurado
```

Níveis:
- 90–100: **Production ready**
- 75–89: **Quase produção** — fix Críticos e Altos
- 50–74: **Pre-produção** — refactor necessário
- 25–49: **Hardening** — gaps estruturais
- 0–24: **Crítico** — não servir tráfego real
