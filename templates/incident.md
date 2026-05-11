# Template — SUPABASE_INCIDENT.md

Estrutura fixa para post-incident review de qualquer incidente que tenha envolvido Supabase: outage, data exposure via RLS, query timeout em escala, key compromise, etc.

Foco: aprender + prevenir + documentar para compliance / blameless postmortem. **Não punitivo**.

---

```markdown
# SUPABASE_INCIDENT — <título curto, factual>

> Post-incident review gerado por **Supabase Architect** em <YYYY-MM-DD>.
> Status: **Open / In Review / Closed**.

## TL;DR (1 parágrafo)

<O que aconteceu, durante quanto tempo, quem foi afetado, root cause em 1 frase, qual foi a remediação>

Exemplo:
> Em 2026-05-10 entre 14:32 e 15:47 UTC, 3 clientes tier Enterprise viram dados de outros tenants no dashboard de invoices devido a policy RLS sem filtro de `organization_id` numa view recém-criada (`v_invoice_summary`). Foi mitigado revogando o GRANT na view. ~120 clientes afetados (visualização apenas, sem download de PII). Root cause: code review faltou cobrir a policy da view.

## Metadata

| Campo | Valor |
|---|---|
| **Detection time** | 2026-05-10 14:38 UTC |
| **Onset time (real)** | 2026-05-10 14:32 UTC |
| **Mitigation time** | 2026-05-10 14:52 UTC |
| **Resolution time** | 2026-05-10 15:47 UTC |
| **MTTD** (mean time to detect) | 6 min |
| **MTTR** (mean time to resolve) | 1h 15min |
| **Severity** | SEV-1 (data exposure) |
| **Status changes** | Detected → Mitigated → Resolved → In review |
| **Author of post-mortem** | <nome> |
| **Reviewers** | <nomes> |

## Severidade

| Nível | Critério |
|---|---|
| **SEV-0** | Total outage OR active data breach com exfil confirmado |
| **SEV-1** | Funcionalidade crítica indisponível OR data exposure sem exfil confirmado OR perda de dados |
| **SEV-2** | Degradação significativa (>50% slower) OR feature secundária indisponível |
| **SEV-3** | Bug com workaround OR feature menor degradada |

Este incidente: **SEV-_**.

## Impacto

### Quem foi afetado
- **Clientes**: <N orgs afetadas; nomes/IDs anonimizados se necessário>
- **Utilizadores**: <N MAU afetados>
- **Dados**: <tipo de dados — PII? financial? operational?>
- **Funcionalidades**: <quais features não funcionaram ou comprometidas>

### Quantificação
- **Downtime**: X minutos
- **Pedidos falhados**: Y (estimativa via logs)
- **Rows expostos**: Z (se aplicável)
- **Revenue impact** (se aplicável): $W

### Sinal externo
- [ ] Customer support tickets recebidos
- [ ] Reportado em redes sociais
- [ ] Reportado em status page externa (Statuspage, etc.)
- [ ] Atingiu mídia / press

## Timeline

Times em **UTC**. Cada entrada com **fonte** (logs, monitoring, chat, etc.).

| Hora | Evento | Fonte |
|---|---|---|
| 14:25 | Deploy de migration `20260510_add_invoice_summary.sql` em produção | Vercel deploy log |
| 14:32 | Primeiros pedidos a `/api/invoices/summary` começam a devolver dados cross-tenant | Application logs |
| 14:38 | Customer support ticket #4521 reporta "ver invoices de outra empresa" | Zendesk |
| 14:40 | On-call (Maria) alertada via PagerDuty | PD log |
| 14:42 | Confirmado via reprodução manual em staging com user da Org A vendo dados da Org B | Slack #incidents 14:42 |
| 14:45 | Escalado para tech lead (João) | Slack |
| 14:52 | **Mitigação aplicada**: `REVOKE SELECT ON public.v_invoice_summary FROM authenticated` | DB audit log |
| 14:55 | Endpoint `/api/invoices/summary` devolve 500 — feature offline mas exposição parada | Application logs |
| 15:10 | Investigação do root cause inicia | Slack |
| 15:32 | Identificado: view não tem RLS aplicada (Postgres views herdam só se `security_invoker = true`) | Slack 15:32 |
| 15:40 | Fix preparado: `ALTER VIEW v_invoice_summary SET (security_invoker = true)` | PR #2341 |
| 15:47 | Fix deployed + endpoint restaurado | Vercel deploy log |
| 15:52 | Verificação manual com user da Org A → não vê dados de Org B | Slack |
| 16:30 | Notificação aos 120 clientes afetados via email | Customer comms |
| **dia seguinte** | Post-mortem rascunhado | Este documento |

## Root cause

### Análise técnica

**O que correu mal**:
- Migration criou view `v_invoice_summary` agregada para dashboard
- View foi grantada a `authenticated`
- **Postgres views por defeito** correm com **privilégios do owner** (não do invoker)
- RLS das tabelas subjacentes não foi aplicada porque o owner (postgres) ignora RLS
- Resultado: qualquer authenticated viu todas as invoices via essa view

**Mecanismo exato**:
```sql
-- Migration que criou o bug
CREATE VIEW public.v_invoice_summary AS
SELECT organization_id, sum(amount) AS total, count(*) AS n
FROM public.invoices  -- RLS aqui IGNORADA na view
GROUP BY organization_id;

GRANT SELECT ON public.v_invoice_summary TO authenticated;
-- Sem `security_invoker = true`, RLS de invoices não se aplica
```

### Heurística aplicável
- **H06**: tabela com RLS mas sem policies → caso especial de view sem `security_invoker`

### Sinais que **deviam** ter prevenido

| Sinal | Porque falhou |
|---|---|
| Code review da migration | Reviewer focou na lógica SQL, não em `security_invoker` |
| pgTAP test de RLS | Sem teste para a view (só para tabelas) |
| Squawk lint | Não cobre `security_invoker` em views (limitação) |
| Audit pré-merge da skill | Não foi corrido (process gap) |

### Categoria

| Categoria | Marcar |
|---|---|
| Bug em código de aplicação | |
| Bug em migration / schema | **X** |
| Configuração errada (Dashboard) | |
| Capacity / scaling | |
| Dependência externa (Stripe, etc.) | |
| Human error em operação | |
| Compromise de credenciais | |
| Outra | |

## Mitigation taken

**Mitigação imediata** (parar a sangria):
```sql
REVOKE SELECT ON public.v_invoice_summary FROM authenticated;
```

**Fix definitivo** (resolveu a causa):
```sql
-- Opção A: security_invoker (preferido, view respeita RLS do user)
ALTER VIEW public.v_invoice_summary SET (security_invoker = true);

-- Opção B (alternativa): RLS direta na view via WHERE
DROP VIEW public.v_invoice_summary;
CREATE OR REPLACE VIEW public.v_invoice_summary
WITH (security_invoker = true) AS
SELECT organization_id, sum(amount) AS total, count(*) AS n
FROM public.invoices
GROUP BY organization_id;

GRANT SELECT ON public.v_invoice_summary TO authenticated;
```

## Comunicação a clientes

### Decisão de divulgação
- Notificação **enviada** a 120 clientes via email em 16:30 UTC
- Status page atualizada às 14:55 UTC (degradation) e 15:50 UTC (resolved)
- DPO/legal informado em 15:20 UTC

### Template usado
```
Assunto: Update sobre incidente de 10 Maio

Estimado <cliente>,

Identificámos e corrigimos um problema entre as 14:32 e 15:47 UTC de hoje
que pode ter permitido que um número limitado de utilizadores visse
informação resumida (total de invoices, contagem) de outras
organizações no dashboard.

Não houve exfiltração confirmada de dados — apenas visualização agregada
sem possibilidade de download. Os detalhes individuais das invoices
permaneceram protegidos.

O problema foi corrigido às 15:47 UTC. Estamos a implementar testes
adicionais para prevenir recorrência. Detalhes técnicos no nosso
post-mortem público em <link>.

Para questões, contactar <email>.

Atenciosamente,
<...>
```

### Disclosure decision matrix
| Critério | Decisão | Notas |
|---|---|---|
| Notificar clientes individualmente | **Sim** | Data exposure mesmo agregado |
| Notificar autoridades (DPO / CNPD) | **Em avaliação** | <72h GDPR window |
| Public post-mortem | **Sim** | Transparência |
| Communicado a media | Não | Escala baixa |

## Action items

### Imediato (resolvido durante incidente)
- [x] Revogar GRANT da view
- [x] Aplicar `security_invoker = true`
- [x] Verificar manualmente em produção
- [x] Notificar clientes afetados

### Curto prazo (até 1 semana)
- [ ] **A1**: Adicionar lint rule no Squawk custom para detectar views sem `security_invoker` em PRs (assignee: @maria, due: 2026-05-17)
- [ ] **A2**: Auditar todas as views existentes em `public.*` para `security_invoker` (assignee: @joão, due: 2026-05-13)
- [ ] **A3**: Adicionar pgTAP test para a view `v_invoice_summary` que valida RLS cross-tenant (assignee: @maria, due: 2026-05-15)
- [ ] **A4**: Atualizar `references/01-rls-patterns.md` com secção dedicada a views + `security_invoker` (assignee: @joão, due: 2026-05-14)

### Médio prazo (até 1 mês)
- [ ] **A5**: Adicionar heurística H53 ao catálogo: "View sem `security_invoker`" (assignee: @joão, due: 2026-06-01)
- [ ] **A6**: Adicionar passo obrigatório em PR template: "Esta migration cria views? Confirmar `security_invoker = true`" (assignee: @maria, due: 2026-05-20)
- [ ] **A7**: Validar com Supabase MCP queries periódicas se há views sem security_invoker (assignee: @joão, due: 2026-06-15)

### Longo prazo (próximo trimestre)
- [ ] **A8**: Migrar audit obrigatório pré-merge para CI (correr skill `/supabase-audit` em PR que toca em migrations) (assignee: @joão, due: 2026-Q3)

## Lessons learned

### O que correu bem
- Detection rápida (6 min via support ticket)
- Mitigação aplicada em 14 min após detection
- Comunicação clara aos clientes
- Sem exfiltração confirmada (apenas visualização agregada)

### O que correu mal
- Migration passou code review sem deteção
- Não existia pgTAP para a view (só para a tabela base)
- Skill `/supabase-audit` não correu antes do merge
- Tempo total até resolução completa: 1h 15min (acceptable para SEV-1 mas melhorável)

### Surpresas
- Assumimos que view "herdava" RLS da tabela base — não é verdade por defeito em Postgres
- Squawk lint não cobre este caso (limitação conhecida; criar rule custom)

## Avaliação contrafactual

> Se a migration tivesse criado uma view com `security_invoker = true` desde o início, isto teria acontecido?

**Não**. Single change point. Sinal claro de que o pattern correto deve ser **default**, não opt-in.

> Se a skill tivesse corrido em PR review, teria detetado?

**Provavelmente sim** — H06 está no catálogo + secção sobre views em `01-rls-patterns.md` (a adicionar). Skill teria emitido alerta antes do merge.

## Compliance considerations

- [ ] GDPR Article 33: notificação a DPA dentro de 72h — **em curso**
- [ ] SOC2 evidence: incidente registado, ação corretiva documentada
- [ ] ISO 27001 A.16: incident management process seguido
- [ ] Audit log de mitigação preservado (DB audit + Slack)

## Apêndice — queries de detecção forense

### Quem viu dados cross-tenant?
```sql
-- (Hipotético — depende de logging existente)
SELECT user_id, organization_id, count(*)
FROM public.api_access_log
WHERE endpoint = '/api/invoices/summary'
  AND created_at BETWEEN '2026-05-10 14:32' AND '2026-05-10 14:52'
GROUP BY user_id, organization_id;
```

### Views sem security_invoker em produção
```sql
SELECT
  n.nspname || '.' || c.relname AS view,
  c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'v'
  AND n.nspname = 'public'
  AND (
    c.reloptions IS NULL
    OR NOT ('security_invoker=true' = ANY(c.reloptions))
  );
```

## Apêndice — relatórios externos

| Stakeholder | Documento | Link / Path |
|---|---|---|
| Cliente afetado | Email + status update | (template above) |
| DPO / Legal | GDPR notification draft | <link interno> |
| C-suite | Executive summary 1 pager | <link interno> |
| Engineering | Este post-mortem | <este ficheiro> |
| Status page | Public update | <statuspage URL> |

## Assinaturas

- **Author**: ___________ Data: _______
- **Tech lead**: ___________ Data: _______
- **Security**: ___________ Data: _______
- **DPO** (se aplicável): ___________ Data: _______
```

---

## Como usar este template

1. Abrir cópia ao começar a investigação. Preencher Timeline em tempo real.
2. Após resolução, fazer review em **<48h** (memory ainda fresca).
3. Apresentar em **incident review meeting** (semanal/quinzenal).
4. Manter ficheiros em `docs/incidents/<YYYY-MM-DD>-<slug>.md`.
5. Linkar action items a issues GitHub / Linear para tracking.

## Princípios (blameless)

- **Sistema, não pessoas**: linguagem foca em "code review não cobriu este caso", não "a Maria errou".
- **Curiosidade, não culpa**: pergunta "como aconteceu?" antes de "quem fez?".
- **Aprender > culpar**: ações corretivas são para o sistema, não punição.
- **Transparência interna**: equipa toda pode ler post-mortem; ajuda formação.
- **Honestidade externa apropriada**: clientes têm direito à verdade, não a detalhes operacionais sensíveis.
