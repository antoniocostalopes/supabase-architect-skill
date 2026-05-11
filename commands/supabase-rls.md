---
description: Gerar, rever ou blindar RLS policies para tabela(s) Supabase
argument-hint: [tabela | path | "audit" | "fix-all"]
---

Aplica a skill **Supabase Architect** em modo RLS sobre `$ARGUMENTS`.

Modos:
- `<table_name>` — gera/revê policies para essa tabela
- `audit` — passa por todas as tabelas em `public.*` e detecta gaps
- `fix-all` — gera SQL completo para resolver todos os gaps detectados
- (vazio) — pede ao developer o que quer fazer

Carrega:
- `references/00-mindset-arquiteto.md`
- `references/01-rls-patterns.md`
- `references/02-multi-tenant-patterns.md`
- `references/10-common-vulnerabilities.md` (V01–V06, V13, V17)

Workflow:
1. Detecta padrão do projeto (user-owned, organization-as-tenant, public-data, hybrid)
2. Verifica se existem helpers (`is_member`, `has_role`) — gera se não houver
3. Para cada tabela em escopo:
   - Verifica `rowsecurity` em `pg_tables`
   - Lista policies existentes em `pg_policies`
   - Compara com o padrão esperado para o tipo de tabela
4. Gera SQL copy-paste com:
   - `ENABLE ROW LEVEL SECURITY`
   - Policies separadas por SELECT/INSERT/UPDATE/DELETE
   - Indexes a suportar as policies
   - Grants apropriados

Output: ficheiro `SUPABASE_RLS.md` seguindo `templates/rls.md`, com:
- Estado atual (coverage gaps)
- Helpers a criar (se ainda não existirem)
- Policies SQL completas por tabela
- Indexes a suportar
- Testes manuais para validar isolamento (especialmente multi-tenant)
- Queries de verificação final
