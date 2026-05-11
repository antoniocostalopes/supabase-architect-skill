---
description: Auditoria Supabase completa — todas as 13 lentes (DB, RLS, Auth, Storage, Realtime, Edge, Performance, Migrations, Production, Docs, RAG/pgvector, CI/CD/Testing, Branching)
argument-hint: [path opcional ou módulo]
---

Aplica o **Supabase Architect** em modo auditoria completa ao `$ARGUMENTS` (ou ao projeto inteiro).

Executa o workflow das 7 fases:
1. Reconhecimento e detecção de stack Supabase
2. Mapeamento da superfície (tabelas, RLS, policies, buckets, edge functions, realtime, embeddings, CI workflows, branches)
3. Análise por capacidade (13 lentes)
4. Detecção de problemas críticos
5. Self-review com confidence scoring (descarta <40%)
6. Priorização e cálculo de score
7. Geração do relatório usando `templates/audit.md`

Carrega todas as `references/*.md` conforme regras de loading em `~/.claude/skills/supabase/SKILL.md`.

Output: `SUPABASE_AUDIT.md` com:
- Sumário executivo + score 0–100
- Mapa do projeto (tabelas, edge functions, buckets, realtime)
- Achados detalhados por capacidade com SQL/code fix + rollback
- Attack chains (mínimo 2)
- Plano de correção em 4 fases
- Apêndices: queries de re-verificação, checklist final
