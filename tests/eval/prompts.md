# Eval Prompts — Supabase Architect

12 cenários canónicos de pedido do user. Cobrem os 12 slash commands, as 13 lentes e os 5 domínios.

Cada prompt simula uma interação real, com **contexto mínimo** e o que o user diria.

---

## P01 — Audit completo (SaaS B2B)

**Contexto**: projeto Next.js + Supabase com `supabase/migrations/` contendo `organizations`, `memberships`, `documents`. Tabela `invoices` sem `ENABLE ROW LEVEL SECURITY`.

**Prompt do user**:
> "Audita o meu projeto Supabase. É um SaaS B2B com organizations + memberships."

**Espera-se que ative**: skill `supabase-architect` automaticamente, ou `/supabase-audit`.

---

## P02 — Review de policy individual

**Contexto**: developer cola uma policy:
```sql
CREATE POLICY "docs_select" ON public.documents
FOR SELECT TO authenticated
USING (auth.role() = 'authenticated');
```

**Prompt do user**:
> "Esta policy está segura para um SaaS multi-tenant?"

**Espera-se que ative**: `/supabase-rls` ou skill automaticamente.

---

## P03 — Review de migração antes de produção

**Contexto**: developer cola migração:
```sql
ALTER TABLE users ADD COLUMN tier text NOT NULL;
CREATE INDEX idx_users_tier ON users(tier);
```

**Prompt do user**:
> "Vou correr esta migração em produção (tabela tem 8M users). É seguro?"

**Espera-se que ative**: `/supabase-migrations` ou skill automaticamente.

---

## P04 — Investigar query lenta

**Contexto**: dashboard com listagem de orders demora 8s.
```sql
SELECT * FROM orders WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50;
```

**Prompt do user**:
> "Esta query demora 8 segundos. Tabela tem 12M rows. Que indexes faltam?"

**Espera-se que ative**: `/supabase-performance`.

---

## P05 — Bucket de storage com PII

**Contexto**: developer descreve:
> "Tenho um bucket `documents` com `public: true` onde os utilizadores carregam contratos. Os paths são `<deal_id>-<filename>.pdf`."

**Prompt do user**:
> "O meu setup de storage está seguro?"

**Espera-se que ative**: `/supabase-storage` ou skill automaticamente.

---

## P06 — Setup RAG / pgvector novo

**Contexto**: projeto novo de chatbot que vai consultar 50k documentos internos da empresa.

**Prompt do user**:
> "Quero adicionar semantic search com pgvector. É multi-tenant (cada cliente tem os seus docs). Como faço o setup?"

**Espera-se que ative**: `/supabase-rag setup`.

---

## P07 — Configuração de MFA enterprise

**Contexto**: SaaS B2B com clientes enterprise a pedir 2FA obrigatório para admins.

**Prompt do user**:
> "Como forço MFA apenas para users com role admin/owner? E como bloqueio operações de billing a quem não fez 2FA na sessão?"

**Espera-se que ative**: `/supabase-auth`.

---

## P08 — Production readiness check

**Contexto**: projeto a 2 semanas do lançamento. Stack: Next.js + Supabase + Stripe.

**Prompt do user**:
> "Vamos lançar em 14 dias. O projeto está pronto para produção? Quais são os bloqueadores?"

**Espera-se que ative**: `/supabase-production-check`.

---

## P09 — Multi-tenant policy generation

**Contexto**: developer tem tabela nova:
```sql
CREATE TABLE public.deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  amount numeric(12,2),
  ...
);
```

**Prompt do user**:
> "Gera-me policies RLS para esta tabela. É multi-tenant — só members da org podem ler, admins podem apagar."

**Espera-se que ative**: `/supabase-rls`.

---

## P10 — Edge Function audit (webhook)

**Contexto**: developer mostra Edge Function que recebe webhook do Stripe e dá update a `orders`.

**Prompt do user**:
> "Esta Edge Function está segura? Aceita webhooks do Stripe."

**Espera-se que ative**: `/supabase-edge-functions`.

---

## P11 — Domínio diferente (hotel/booking)

**Contexto**: projeto de booking system para hotel boutique.

**Prompt do user**:
> "Como evito double-booking? Tenho `bookings(room_id, checkin_at, checkout_at)`."

**Espera-se que ative**: skill, com **few-shot do exemplo hotel** (não SaaS), usando `tstzrange` + `EXCLUDE GiST`.

---

## P12 — Setup CI/CD com pgTAP

**Contexto**: equipa quer prevenir regressão de RLS via CI.

**Prompt do user**:
> "Como configuro testes pgTAP que correm em PR e bloqueiam merge se RLS partir?"

**Espera-se que ative**: skill, carregando `references/13-ci-cd-testing.md`.

---

## Como usar estes prompts

1. **Manual**: copiar prompt, colar no Claude Code com skill instalada, comparar com [`expected.md`](expected.md), pontuar com [`rubric.md`](rubric.md).
2. **Smoke test rápido**: correr P01, P04, P06, P11 — cobertura cruzada (audit completo, performance, RAG, domínio não-SaaS).
3. **Pre-release**: correr os 12. Documentar scores em `tests/results/v<versão>.md` (criar quando aplicável).

Cobertura por capacidade:

| Capacidade | Prompts |
|---|---|
| RLS | P01, P02, P09 |
| Migrations | P03 |
| Performance | P04 |
| Storage | P05 |
| RAG / pgvector | P06 |
| Auth (MFA) | P07 |
| Production readiness | P08 |
| Multi-tenant | P02, P09, P11 |
| Edge Functions | P10 |
| Domain few-shot | P11 (hotel), P06 (RAG) |
| CI/CD | P12 |
| Audit completo | P01 |
