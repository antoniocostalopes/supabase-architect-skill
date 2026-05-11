---
description: Auditar Supabase Realtime — Postgres Changes, Broadcast, Presence, escala, custo, filtros
argument-hint: [tabela ou canal opcional]
---

Aplica a skill **Supabase Architect** em modo Realtime.

Carrega:
- `references/07-realtime-patterns.md`
- `references/10-common-vulnerabilities.md` (V12, V19)

Workflow:
1. Lista tabelas em `pg_publication_tables` para `supabase_realtime`
2. Para cada tabela:
   - Verifica `REPLICA IDENTITY` (default vs FULL — full é caro)
   - Avalia se realtime é justificado para o caso de uso
   - Procura RLS policies (realtime respeita RLS — confirmar)
3. Procura no código:
   - `supabase.channel(...).on('postgres_changes', ...)` — verificar `filter` server-side
   - Canais globais vs por tenant/recurso
   - `unsubscribe()` em cleanup (React useEffect, Vue onUnmounted)
4. Avalia Broadcast / Presence:
   - Existem policies em `realtime.messages` para autorização?
   - Sem policies = qualquer cliente subscreve qualquer canal
5. Detecta tabelas que **não** deveriam estar em realtime:
   - `audit_logs`, `events`, `telemetry`, tabelas com escrita > 100/s

Output: `SUPABASE_SECURITY.md` (secção Realtime) seguindo `templates/security.md`:
- Tabela de subscrições com diagnóstico
- Achados:
  - Subscriptions sem `filter` server-side
  - Tabelas com realtime desnecessário
  - Broadcast/Presence sem policies em `realtime.messages`
  - `REPLICA IDENTITY FULL` em tabelas com escrita alta
- SQL para remover tabelas indevidas da publication
- Patches no código cliente:
  - Adicionar `filter: 'organization_id=eq.${orgId}'`
  - Cleanup em useEffect
  - Throttle/debounce em broadcast (cursores, typing)
- Padrão recomendado: tabela `notifications` dedicada em vez de subscrever tabelas de domínio
- Policies em `realtime.messages` para autorização multi-tenant
