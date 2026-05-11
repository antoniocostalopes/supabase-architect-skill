# Supabase MCP Integration

Como a skill **lê o schema diretamente** do projeto Supabase via Model Context Protocol em vez de pedir ficheiros ao developer.

## O que é o Supabase MCP

O Supabase mantém um servidor MCP oficial (`@supabase/mcp-server-supabase`) que expõe a API de management e o Postgres do projeto como **ferramentas** que o LLM pode invocar diretamente. Resultado: a skill passa de **passiva** (precisa que user cole schema/migrações) a **proativa** (consulta o estado real).

## Setup para o user

### Pré-requisitos
- Node.js 18+ instalado localmente
- `SUPABASE_ACCESS_TOKEN` (Dashboard → Account → Access Tokens)
- `SUPABASE_PROJECT_REF` do projeto a auditar

### Configuração em `.claude/mcp.json` (ou equivalente)

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--read-only",
        "--project-ref=<PROJECT_REF>"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "<ACCESS_TOKEN>"
      }
    }
  }
}
```

### Modos
| Flag | Comportamento |
|---|---|
| `--read-only` | (default recomendado) Apenas SELECT, inspeção de schema, metadados. **Sem DDL/DML**. |
| (sem flag) | Permite executar SQL arbitrário — **destrutivo**. Só usar em projetos dev. |
| `--project-ref=<ref>` | Limita a um projeto específico. **Crítico**: sem isto, ferramenta tem acesso a todos os projetos do token. |

## Ferramentas expostas (típicas)

| Tool MCP | Equivalente skill | Uso |
|---|---|---|
| `list_tables` | Inspecção de schema | Fase 1 — Reconhecimento |
| `list_policies` | RLS audit | Fase 3 — RLS |
| `list_extensions` | Detecta pgvector, pg_cron, etc. | Fase 1 |
| `get_logs` | Análise de erros | Triagem |
| `execute_sql` (read-only) | Queries de diagnóstico | Validação |
| `apply_migration` (não read-only) | Aplicar fix | Apenas após review |
| `list_migrations` | Histórico | Fase 2 |
| `generate_typescript_types` | Sync `database.types.ts` | DX |

(A lista exata depende da versão do servidor MCP. Verificar `tools/list` da SDK.)

## Workflow com MCP — fase 1 transformada

### Sem MCP
1. Developer corre `supabase db dump --schema public > schema.sql`
2. Cola para o chat ou abre em editor
3. Skill lê via Read tool
4. Limitada à info que o developer escolheu partilhar

### Com MCP
1. Skill invoca `list_tables` → lista completa
2. Skill invoca `list_policies` → todas as policies por tabela
3. Skill invoca `execute_sql` com queries de diagnóstico (RLS coverage, FKs sem index, etc.) — read-only
4. Cobertura completa sem fricção

## Padrões de uso na skill

### P1. Reconhecimento ativo (Fase 1)
```
Skill: "MCP supabase disponível, a iniciar reconhecimento ativo."
→ list_tables(schema: 'public')
→ list_policies(schema: 'public')
→ list_extensions
→ execute_sql("SELECT pubname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'")
```

### P2. Diagnóstico automatizado (Fase 4)
Em vez de pedir ao user "corre esta query e mostra-me", a skill corre diretamente:

```sql
-- RLS coverage gap
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false;
```

### P3. Validação pós-fix
Após sugerir `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, a skill **valida** com `execute_sql` que ficou aplicado (se o user correr) — sem precisar de pedir confirmação manual.

### P4. Análise de logs em incidente
```
Skill: "A investigar erro 500 nas últimas 6h."
→ get_logs(service: 'api', range: '6h')
→ filtrar por status >= 500
→ correlacionar com migrations recentes
```

## Regras de segurança (não-negociáveis)

### R1. `--read-only` por defeito
Em **qualquer** projeto que tenha tráfego real:
```json
"args": ["-y", "@supabase/mcp-server-supabase@latest", "--read-only", "--project-ref=..."]
```

### R2. Token de scope reduzido
Não usar o "personal access token" master. Em vez disso, criar um token dedicado para MCP com escopo mínimo (apenas o projeto target).

### R3. Project-scoped
**Sempre** passar `--project-ref=<ref>`. Sem este flag, comprometimento do token = comprometimento de todos os projetos do account.

### R4. Sem prod sem aprovação
Sugestão de DDL/DML detectada pela skill **não corre automaticamente**, mesmo com MCP em modo write. Sempre apresentar SQL ao user e pedir confirmação explícita.

### R5. Audit log local
A skill mantém log de queries MCP executadas. Em projetos sensíveis, anexar ao relatório:
```markdown
## Apêndice — Queries MCP executadas
1. `list_tables(schema='public')` — 2026-05-11 14:32:01
2. `execute_sql("SELECT count(*) FROM pg_policies WHERE schemaname='public'")` — 14:32:03
3. ...
```

### R6. Sem dados sensíveis para context window
Se o MCP devolver row sample com PII, a skill **redige** antes de processar:
```
→ execute_sql("SELECT * FROM users LIMIT 5")
→ before display: replace emails, names, phone numbers with <REDACTED>
```

## Comportamento da skill quando MCP está disponível

### Detecção
No início de qualquer comando (`/supabase-audit`, etc.), a skill verifica se há ferramentas MCP do Supabase ativas:

```
Se MCP supabase disponível:
  - Anunciar: "MCP supabase detetado. A usar modo ativo."
  - Usar list_tables, list_policies, execute_sql para Fase 1+2+4
  - Skipping de pedidos ao user para schema/migrations
Senão:
  - Modo passivo: pedir ao user que cole schema, migrations, types, ou indicar paths
```

### Anúncio explícito
A skill diz **sempre** ao user quando vai consultar a DB via MCP:
> "Vou consultar o schema via MCP (read-only) — list_tables + list_policies."

Razão: confiança e auditoria. O user sabe o que está a ser inspecionado.

### Fallback gracioso
Se uma chamada MCP falhar (token inválido, ratelimit, projeto inacessível), a skill cai para modo passivo sem abortar a análise.

## Comparativo: skill com/sem MCP

| Tarefa | Sem MCP | Com MCP |
|---|---|---|
| Listar tabelas sem RLS | Pede ao user para correr query e colar | Corre automaticamente |
| Audit de policies | Pede `pg_policies` dump | List_policies + filtragem inline |
| Validar fix aplicado | Pede ao user re-correr query | Re-executa imediatamente |
| Detectar extension `vector` | Pergunta ao user | list_extensions |
| Análise de logs em erro | Pede screenshots | get_logs filtrado |
| Sync types após mudança | Pede `supabase gen types` manual | generate_typescript_types tool |

Tempo médio de auditoria completa: **~50% mais rápida com MCP**.

## Limitações conhecidas

- **MCP write tools** (apply_migration) requerem confirmação manual em Claude Code — desenho seguro.
- **execute_sql** com timeout default ~30s. Queries pesadas falham — partir em batches.
- **Connection pooling**: cada chamada cria conexão fresca. Não fazer 100 queries num command — agregar.
- **Não cobre Edge Functions** — listar/inspecionar funções via MCP é limitado; usar Supabase CLI separadamente.
- **Auth schema** não é totalmente exposto via MCP. Para auditar `auth.users` profundamente, complementar com SQL direto.

## Quando NÃO usar MCP

- **Projetos com PII estrita** (saúde, finanças): considerar isolar acesso. Mesmo em read-only, queries podem trazer rows para o context.
- **Compliance HIPAA/SOC2 stricter**: validar com legal/security antes de configurar MCP em prod.
- **Auditoria forense**: pode haver requisito de **não tocar** no projeto. Modo passivo (export prévio + análise offline) é melhor.

## Integração com workflow existente

A SKILL.md descreve "Fase 1 — Reconhecimento" como detecção de stack via ficheiros. Com MCP:

- **Adicionalmente**: a skill chama `list_tables`, `list_extensions`, `list_policies` direto.
- **Mantém-se**: leitura de `supabase/migrations/`, `supabase/functions/`, env vars, `.env.example`, e código cliente — porque MCP **não** vê o repo de código.

MCP cobre o **estado runtime da DB**; ficheiros cobrem o **estado intended do código**. Os dois confrontados = detecção de **drift**.

## Checklist MCP

- [ ] `@supabase/mcp-server-supabase` instalado e configurado em `.claude/mcp.json` (ou settings da Claude Code)
- [ ] Flag `--read-only` ativa (ou justificação por escrito para desativar)
- [ ] Flag `--project-ref=<ref>` específico (não wildcard)
- [ ] `SUPABASE_ACCESS_TOKEN` em env secret, não commitado
- [ ] Token de scope reduzido (não master account token)
- [ ] Skill anuncia queries MCP antes de executar
- [ ] PII redacted antes de entrar no context
- [ ] Audit log das queries MCP no relatório
- [ ] Fallback para modo passivo testado
