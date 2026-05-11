---
description: Rever ou gerar migrações Supabase (zero-downtime, rollback documentado)
argument-hint: [ficheiro de migração | "new <nome>" | "review-pending"]
---

Aplica a skill **Supabase Architect** em modo migração.

Modos:
- `<ficheiro.sql>` — revê a migração indicada (safety + rollback + indexes)
- `new <nome>` — gera nova migração com template seguro
- `review-pending` — revê todas as migrações ainda não aplicadas em produção
- (vazio) — analisa última migração pendente

Carrega:
- `references/04-migration-safety.md`
- `references/10-common-vulnerabilities.md` (V08–V10, V18)
- `references/01-rls-patterns.md` (se houver tabela nova)
- `references/03-postgresql-performance.md` (para validar indexes)

Workflow:
1. Lê o conteúdo da migração
2. Classifica cada operação:
   - Verde (additive, baixo risco)
   - Amarelo (cuidado, exige estratégia)
   - Vermelho (destrutivo, exige aprovação explícita)
3. Detecta padrões problemáticos:
   - `CREATE INDEX` sem `CONCURRENTLY` em tabela grande
   - `ALTER ... NOT NULL` sem `DEFAULT` constante
   - `ALTER ... TYPE` que reescreve tabela
   - `DROP COLUMN` sem deprecação prévia
   - `DELETE`/`UPDATE` sem `WHERE`
   - `DISABLE ROW LEVEL SECURITY` sem reactivação
   - Migrações que misturam DDL pesado com DML em massa
4. Verifica se tabelas novas têm RLS + policies + indexes
5. Gera rollback (`.down.sql`) ou documenta não-recuperabilidade

Output: `SUPABASE_MIGRATIONS.md` seguindo `templates/migrations.md`:
- Metadata da migração (risk level, tipo, rollback strategy)
- Análise de segurança operação a operação
- Migração corrigida (se necessário)
- Rollback SQL
- Plano de deploy (pré-condições, execução, verificação pós-deploy)
- Caso especial: expand/contract para mudanças breaking
