# Glossário — Supabase Architect

Termos técnicos usados ao longo da skill, agrupados por área. Definições curtas + onde encontrar mais detalhe.

## Postgres / SQL

| Termo | Definição |
|---|---|
| **DDL** | Data Definition Language: comandos que alteram estrutura (`CREATE`, `ALTER`, `DROP`). |
| **DML** | Data Manipulation Language: comandos que mexem em dados (`INSERT`, `UPDATE`, `DELETE`, `SELECT`). |
| **DCL** | Data Control Language: gestão de permissões (`GRANT`, `REVOKE`). |
| **FK** | Foreign Key. Constraint que aponta para PK de outra tabela. Em Postgres **não cria index automaticamente**. |
| **PK** | Primary Key. Identificador único da linha. |
| **MVCC** | Multi-Version Concurrency Control: como Postgres lida com leituras concorrentes sem locks. |
| **WAL** | Write-Ahead Log: registo durável de mudanças, base de replicação e PITR. |
| **EXPLAIN** | Mostra o plano de execução duma query. `EXPLAIN ANALYZE` corre + mede. |
| **CTID** | Identificador físico de uma linha (tuple) numa tabela. Muda em UPDATE. |
| **VACUUM** | Limpa tuples mortos. `ANALYZE` actualiza estatísticas do planner. |
| **TOAST** | Mecanismo de Postgres para armazenar valores grandes (`text`, `jsonb`) out-of-line. |
| **Seq Scan** | Sequential scan: lê toda a tabela. Mau sinal em tabelas grandes. |
| **Index Scan** | Lê via index. Boa performance se a query suportar. |
| **Bitmap Scan** | Híbrido — Postgres usa quando há múltiplas condições. |
| **GIN** | Generalized Inverted Index. Bom para `jsonb`, full-text search, arrays. |
| **GiST** | Generalized Search Tree. Suporta range types, geometry (PostGIS), trigrams. |
| **BTREE** | Default. Boa para igualdade, range numérico, `ORDER BY`. |
| **Partial index** | Index que cobre só linhas que satisfazem `WHERE` (ex: `WHERE deleted_at IS NULL`). |
| **Generated column** | Coluna calculada (`GENERATED ALWAYS AS (expr) STORED`). |
| **Materialized view** | View persistida em disco. Refresh manual ou via cron. |
| **tstzrange** | Tipo nativo para intervalos `[start, end)` de timestamps com timezone. |
| **EXCLUDE constraint** | Constraint que previne combinações (ex: dois bookings overlapping no mesmo room). |

## Supabase / Auth

| Termo | Definição |
|---|---|
| **PostgREST** | API REST automática que Supabase expõe sobre Postgres. Cliente JS chama-a. |
| **`auth.uid()`** | Função SQL que retorna o UUID do user autenticado na request atual. |
| **`auth.jwt()`** | Retorna o payload completo do JWT como `jsonb`. |
| **`auth.role()`** | `anon` (sem JWT) ou `authenticated` (com JWT válido). |
| **anon** | Role Postgres usada por clientes sem login. |
| **authenticated** | Role Postgres usada por clientes com JWT válido. |
| **service_role** | Role com privilégios totais, **bypass de RLS**. Só usar server-side. |
| **JWT** | JSON Web Token. Payload + signature. Identifica o user na request. |
| **AAL1** | Authentication Assurance Level 1. Login simples (password / OAuth / magic). |
| **AAL2** | Authentication Assurance Level 2. Login + segundo factor (TOTP). |
| **TOTP** | Time-based One-Time Password (RFC 6238). Google Authenticator, Authy. |
| **MFA** | Multi-Factor Authentication. AAL1 + factor adicional. |
| **SSO** | Single Sign-On. User entra com credenciais de provider externo. |
| **SAML** | Standard XML para SSO entre Identity Provider (IdP) e Service Provider (SP). |
| **PKCE** | Proof Key for Code Exchange. Mitiga interceção de code em OAuth para SPAs/mobile. |
| **Magic link** | Login por link emailado. Sem password. |
| **Refresh token rotation** | Cada refresh devolve novo refresh token; o antigo é invalidado. |
| **Reuse detection** | Se um refresh token usado é re-usado, revoga toda a árvore. |
| **Custom claims** | Campos adicionais no JWT, definidos via Access Token Hook. |
| **JIT provisioning** | Just-In-Time: criar conta/membership ao primeiro login (típico em SSO). |

## RLS (Row Level Security)

| Termo | Definição |
|---|---|
| **RLS** | Row Level Security: policies em cada tabela definem que linhas cada role vê/edita. |
| **Policy** | Regra SQL aplicada antes de SELECT/INSERT/UPDATE/DELETE. |
| **USING** | Filtra linhas existentes (SELECT/UPDATE/DELETE). |
| **WITH CHECK** | Valida estado de linhas novas/atualizadas (INSERT/UPDATE). |
| **PERMISSIVE** | Default. Múltiplas policies fazem OR. |
| **RESTRICTIVE** | Múltiplas policies fazem AND. Usar para restrições adicionais. |
| **FORCE ROW LEVEL SECURITY** | Faz com que o owner da tabela também respeite RLS. |
| **SECURITY DEFINER** | Função corre com privilégios do owner. Usar para helpers tipo `is_member`. |
| **SECURITY INVOKER** | Default. Função corre com privilégios do caller. |
| **`STABLE`** | Função não modifica DB e retorna o mesmo resultado dentro da mesma query. Cacheável. |
| **`IMMUTABLE`** | Função pura: mesmo input → mesmo output sempre. |
| **`VOLATILE`** | Default. Pode ter side effects, pode variar. |
| **search_path** | Lista de schemas onde Postgres procura objetos. Em SECURITY DEFINER, **fixar**. |
| **IDOR** | Insecure Direct Object Reference. User acede a recurso de outro user via ID exposto. |
| **BOLA** | Broken Object Level Authorization (API equivalent of IDOR). |

## Multi-tenant

| Termo | Definição |
|---|---|
| **Tenant** | Cliente isolado lógicamente (organização, workspace, conta). |
| **`organization_id`** | FK denormalizada em todas as tabelas de tenant, para policies diretas. |
| **Membership** | Relação user ↔ organization, com role. |
| **`is_member(org_id)`** | Helper SECURITY DEFINER que verifica se o user é membro ativo. |
| **`has_role(org_id, role)`** | Helper que verifica role mínimo. |
| **Denormalização de tenant** | Repetir `organization_id` em tabelas filhas para evitar JOINs em policies. |
| **Cross-tenant attack** | Quando user de Org A consegue ler/escrever dados de Org B. |

## Storage

| Termo | Definição |
|---|---|
| **Bucket** | Namespace de armazenamento. `public: true/false`. |
| **`storage.objects`** | Tabela Postgres com 1 linha por ficheiro. Tem RLS própria. |
| **Signed URL** | URL temporário gerado pelo servidor, com TTL. |
| **`storage.foldername(name)`** | Extrai partes do path por `/`. Usado em policies path-based. |
| **MIME type** | Tipo de conteúdo (`image/jpeg`, `application/pdf`). |
| **Magic bytes** | Primeiros bytes do ficheiro que identificam o tipo real (não confiar em extension). |
| **Path traversal** | Vulnerabilidade: input do user contém `..` ou paths absolutos. |
| **Image transformations** | Resize/quality on-the-fly via parâmetros no Storage. |

## Realtime

| Termo | Definição |
|---|---|
| **Postgres Changes** | Subscrição a INSERT/UPDATE/DELETE numa tabela. |
| **Broadcast** | Pub/sub efémero entre clientes. Não persiste. |
| **Presence** | Lista de users online num canal, com estado. |
| **`supabase_realtime` publication** | Publication Postgres que define tabelas observáveis. |
| **REPLICA IDENTITY** | `DEFAULT` (só PK em UPDATE/DELETE) ou `FULL` (todas as colunas). |
| **Channel** | Canal lógico de subscrição. Por escopo (tenant, recurso). |
| **`filter`** | Predicado server-side num subscribe (`organization_id=eq.X`). |
| **`realtime.messages`** | Tabela com policies que controlam acesso a broadcast/presence. |

## Edge Functions

| Termo | Definição |
|---|---|
| **Edge Function** | Worker Deno na infra Supabase. HTTP endpoint server-side. |
| **`userClient`** | Cliente Supabase criado com a anon key + JWT do user. RLS aplicada. |
| **`adminClient`** | Cliente com service_role. Bypass RLS. Só após validar permissões. |
| **Idempotência** | Reprocessar a mesma operação não causa efeito adicional (útil em webhooks). |
| **CORS** | Cross-Origin Resource Sharing. Headers que controlam quem pode chamar. |
| **Webhook signature** | Hash assinado (Stripe, etc.) que prova origem genuína. |

## Performance / Indexing

| Termo | Definição |
|---|---|
| **N+1** | Anti-pattern: loop no cliente → 1 query por iteração. Resolver com embedding ou JOIN. |
| **OFFSET pagination** | `OFFSET 1000 LIMIT 50`. Lento em listas grandes. |
| **Cursor pagination** | `WHERE created_at < $cursor`. O(log n). |
| **Keyset pagination** | Sinónimo de cursor pagination. |
| **EXPLAIN ANALYZE** | Corre a query e mostra plano real + tempos. |
| **Buffers shared hit/read** | Páginas vindas de cache (hit) vs disco (read). |
| **pg_stat_user_tables** | Vista com seq_scan, idx_scan, rows fetched por tabela. |
| **pg_stat_user_indexes** | Vista com idx_scan por index. `idx_scan = 0` = index nunca usado. |

## RAG / Vector / AI

| Termo | Definição |
|---|---|
| **pgvector** | Extensão Postgres para tipo `vector` + ANN search. |
| **Embedding** | Vector denso que representa significado de texto. |
| **ANN** | Approximate Nearest Neighbors. Procura "perto" sem comparar tudo. |
| **HNSW** | Hierarchical Navigable Small World. Index ANN moderno, rápido + alta recall. |
| **IVFFlat** | Index ANN baseado em clusters. Build rápido, query mais lenta que HNSW. |
| **Operator class** | Para HNSW/IVFFlat: `vector_l2_ops`, `vector_cosine_ops`, `vector_ip_ops`. |
| **Distance operators** | `<->` (L2), `<=>` (cosine), `<#>` (inner product negativo). |
| **Cosine similarity** | `1 - (a <=> b)`. Entre 0 e 1 para vectores normalizados. |
| **Chunking** | Partir documento em pedaços (200-1500 tokens) para embedar. |
| **Overlap** | Sobreposição entre chunks (10-20%) para preservar contexto. |
| **FTS** | Full-Text Search. Postgres nativo via `tsvector` + `tsquery`. |
| **Hybrid search** | Combinar FTS lexical + vector semantic. |
| **RRF** | Reciprocal Rank Fusion. Fórmula para combinar rankings: `Σ 1/(k + rank_i)`. |
| **Reranking** | Modelo posterior (Cohere Rerank, Voyage Rerank) que afina top-N. |
| **Quantization** | Compressão (halfvec = float16, binary = 1 bit). Trade-off recall vs storage. |

## CI/CD / Testing

| Termo | Definição |
|---|---|
| **pgTAP** | Framework de testing para Postgres. `plan()`, `is()`, `throws_ok()`. |
| **Squawk** | Linter de migrations SQL. Deteta operações perigosas. |
| **supabase db diff** | Compara schema atual vs migrações. Deteta drift. |
| **Smoke test** | Teste pós-deploy mínimo para confirmar que o serviço sobe. |
| **Branch protection** | Regras em GitHub que forçam reviews + checks antes de merge. |
| **Expand/contract** | Pattern de migração em duas fases (add new, remove old). |
| **Backfill** | Popular dados de coluna nova em registos antigos, geralmente em batches. |

## Branching / Environments

| Termo | Definição |
|---|---|
| **Branching** | Feature Supabase Pro+ que cria projeto efémero por PR. |
| **PITR** | Point-In-Time Recovery. Restore para um instante específico. |
| **RTO** | Recovery Time Objective. Quanto tempo para restaurar. |
| **RPO** | Recovery Point Objective. Quanta perda de dados aceitável. |
| **Scrubbing** | Remoção/anonimização de PII em dumps antes de usar em staging. |
| **Seed** | Dados iniciais populados via SQL para dev/staging. |
| **Drift** | Diferença entre schema esperado (migrations) e schema real (DB). |

## MCP (Model Context Protocol)

| Termo | Definição |
|---|---|
| **MCP** | Protocolo da Anthropic para LLMs invocarem ferramentas externas. |
| **MCP server** | Processo que expõe ferramentas (list_tables, execute_sql) ao LLM. |
| **Supabase MCP** | Servidor oficial `@supabase/mcp-server-supabase`. |
| **Modo ativo** | Skill consulta DB diretamente via MCP. |
| **Modo passivo** | Skill pede ao user ficheiros (modo legacy). |
| **`--read-only`** | Flag que limita o MCP a queries não-destrutivas. |
| **`--project-ref`** | Limita o MCP a um projeto específico. |

## Outros patterns

| Termo | Definição |
|---|---|
| **Outbox pattern** | Tabela `event_outbox` + worker que entrega; previne perda de eventos em falha de webhook. |
| **Optimistic locking** | Versionamento via `version int` + check no UPDATE. |
| **Pessimistic locking** | `SELECT ... FOR UPDATE` segura linha. |
| **Soft delete** | `deleted_at` em vez de DELETE. |
| **Audit log** | Tabela imutável de operações sensíveis. |
| **Idempotency key** | Token único do cliente que previne duplicação em retries. |
| **Tombstone** | Marker que indica "isto foi apagado", para sync entre clientes. |

## Severidade (sistema da skill)

| Termo | Definição |
|---|---|
| **Crítico** | Exploração remota → RCE / DB exposure / account takeover / perda de dados. |
| **Alto** | Exploração realista com impacto significativo, mas requer alguma condição. |
| **Médio** | Mau pattern, performance issue, anti-pattern. |
| **Baixo** | Higiene, naming, falta de docs. |
| **Confidence** | 95% (observado), 80% (forte evidência), 60% (suspeita), <40% (descartado). |

## Vocabulário pt-PT vs en

A skill é escrita em **pt-PT** mas o SQL e termos técnicos estabelecidos ficam em inglês.

| pt-PT | en |
|---|---|
| ficheiro | file |
| ecrã | screen |
| utilizador | user |
| palavra-passe | password |
| ligação | connection |
| programador | developer |
| código | code |

(Não traduzir: `INSERT`, `UPDATE`, `RLS`, `JWT`, `index`, `cache`, `bucket`, `migration`.)

## Referências

- **Conceitos profundos**: ver `references/`
- **Anti-patterns codificados**: ver `references/10-common-vulnerabilities.md` (V01–V20)
- **Decisões da skill**: ver `CHANGELOG.md`
