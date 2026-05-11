# Template — SUPABASE_PRODUCTION.md

Estrutura fixa para relatório de readiness de produção.

---

```markdown
# SUPABASE_PRODUCTION — <project_name>

> Production readiness assessment por **Supabase Architect** em <YYYY-MM-DD>.
> Target ship date: <data ou "TBD">.

## Veredicto

> **<READY | NOT READY>** — <1 frase de justificação>

## Score

| Secção | Total | OK | Falha | Score |
|---|---|---|---|---|
| A. Security | <n> | <n> | <n> | <%> |
| B. Performance | <n> | <n> | <n> | <%> |
| C. Migrations | <n> | <n> | <n> | <%> |
| D. Data integrity | <n> | <n> | <n> | <%> |
| E. Observability | <n> | <n> | <n> | <%> |
| F. Backups & DR | <n> | <n> | <n> | <%> |
| G. Env hygiene | <n> | <n> | <n> | <%> |
| H. App-level | <n> | <n> | <n> | <%> |
| I. Rate limiting | <n> | <n> | <n> | <%> |
| J. Compliance | <n> | <n> | <n> | <%> |
| K. Documentation | <n> | <n> | <n> | <%> |
| **Global** | | | | **<%>** |

## Bloqueadores (impedem ship)

1. **[Security]** <descrição + fix>
2. **[Security]** <descrição + fix>
3. …

## Riscos altos (resolver antes de tráfego significativo)

1. **[Performance]** <descrição>
2. **[Backups]** Restore nunca foi testado.
3. …

## Status por secção

### A. Security
- [x] RLS coverage em todas as tabelas de utilizador
- [x] service_role isolado server-side
- [ ] **Bucket `documents` ainda público** (Crítico)
- [x] Auth configurada com confirm email + rotação de refresh
- [ ] **Edge Function `send-invite` sem auth check** (Crítico)
- [x] SECURITY DEFINER com search_path fixo
- …

### B. Performance
- [x] FKs com index
- [x] Indexes em `organization_id`
- [ ] **Tabela `orders` sem partial index para `WHERE status='pending'`** (Alto)
- [x] Realtime apenas em tabelas necessárias
- [x] Pooling configurado (transaction mode para serverless)

### C. Migrations
- [x] Versionadas em git
- [x] Sem drift detectado (`supabase db diff` limpo)
- [ ] **Migração 20260103 sem rollback documentado** (Médio)
- [x] Testadas localmente

### D. Data integrity
- [x] FKs com `ON DELETE` apropriado
- [x] CHECK constraints em campos críticos
- [x] Enums para vocabulário fechado
- [x] `updated_at` automático

### E. Observability
- [x] Logs estruturados em Edge Functions
- [ ] **Sem alertas configurados no Dashboard** (Alto)
- [x] Audit logs para operações sensíveis

### F. Backups & DR
- [x] Backups automatizados (Supabase plan)
- [ ] **Restore nunca foi testado** (Alto)
- [ ] RTO/RPO não documentados (Médio)

### G. Env hygiene
- [x] `.env.example` no repo
- [x] Dev/staging/prod separados
- [ ] **Service role rotation date desconhecido** (Baixo)

### H. App-level
- [x] Cliente usa apenas anon key
- [x] SSR com `@supabase/ssr` e `getUser()`
- [x] Middleware refresca sessão

### I. Rate limiting
- [x] Supabase Auth rate limits ativos
- [ ] **Edge Function `create-order` sem rate limit** (Alto)

### J. Compliance
- [ ] GDPR export/delete process não definido (Médio)
- [x] PII retention policy em audit_logs
- [x] DPA assinada com Supabase

### K. Documentation
- [x] SUPABASE_ARCHITECTURE.md em `docs/`
- [x] SUPABASE_RLS.md em `docs/`
- [ ] **Runbook de incidentes não existe** (Alto)

## Plano de remediação

### Bloqueadores — fix antes de ship (estimativa: X dias)
1. Tornar bucket `documents` privado + migrar para signed URLs.
2. Adicionar auth check à Edge Function `send-invite`.

### Críticos — 1ª semana pós-ship
1. Test restore de backup.
2. Configurar alertas Dashboard.
3. Escrever runbook de incidentes.

### Importantes — 1º mês
1. Rate limiting custom em Edge Functions.
2. GDPR export/delete process.
3. Documentar RTO/RPO.

## Queries de re-verificação

Correr antes de approve final:

```sql
-- (incluir queries de "Apêndice — Queries de auditoria automatizada" de 09-production-checklist.md)
```

## Sign-off

- [ ] Tech lead: ___________________ Data: _______
- [ ] Security: ___________________ Data: _______
- [ ] Engineering manager: ___________________ Data: _______
```
