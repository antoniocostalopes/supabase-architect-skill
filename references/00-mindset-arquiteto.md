# Mindset do Arquiteto Supabase

Princípios que orientam toda análise, design e auditoria nesta skill.

## 1. Pensa em produção, não em dev

Toda decisão é tomada com a pergunta: *"O que acontece quando esta tabela tem 50M de linhas, 200 tenants e 10k utilizadores concorrentes?"*

- Schemas de dev escondem problemas. Index missing aparece a 50k rows, não a 50.
- Policies sem JOIN parecem rápidas em local. Em produção, com 100k memberships, viram bottleneck.
- `SELECT *` num ORM passa despercebido até a tabela ganhar uma coluna `jsonb` grande.
- Realtime sem filtro funciona com 1 cliente. Com 1000, satura a conexão.

## 2. RLS é a fronteira primária

No Supabase, **o cliente fala diretamente com a base de dados**. Não há "backend a sanitizar". A única barreira entre um utilizador malicioso e os teus dados é:

1. **RLS bem desenhado** em cada tabela
2. **Grants do role `anon`/`authenticated`** corretamente limitados
3. **Storage policies** em `storage.objects`

Se a RLS estiver mal, *não há como recuperar* — não é equivalente a um bug de aplicação. É exposição direta.

Corolário: **tabela com dados de utilizador SEM `ENABLE ROW LEVEL SECURITY` é Crítico, sempre.**

## 3. Multi-tenant: isolamento é não-negociável

A pergunta nunca é *"posso ver os meus dados?"*. É *"posso ver os dados do tenant ao lado?"*.

Toda policy multi-tenant deve responder NÃO à pergunta:
> "Se eu sou utilizador do tenant A e forjar um pedido a pedir registos do tenant B, a base devolve algo?"

Padrão errado (parece certo mas não é):
```sql
USING (user_id = auth.uid())  -- e o organization_id?
```

Padrão correto:
```sql
USING (
  organization_id IN (
    SELECT organization_id FROM memberships WHERE user_id = auth.uid()
  )
)
```

## 4. service_role é uma chave de explosão

`service_role` ignora RLS. Em qualquer sítio onde apareça, perguntar:

- Está apenas em **server-side** (Edge Function, backend Node/Next route handler, server action)?
- A função/route **valida auth** antes de usar?
- A função **valida ownership/membership** do recurso pedido?
- A chave está em **env var server-only** (sem `NEXT_PUBLIC_` ou equivalente)?

Se alguma resposta for "não" → **Crítico**.

## 5. Performance é arquitetura, não tuning tardio

Indexes não se adicionam "depois". Adicionam-se quando se desenha a tabela:

- Toda **FK** precisa de index (Postgres não cria automaticamente).
- Toda coluna usada em `WHERE`, `JOIN`, `ORDER BY` precisa de index ou é candidata.
- `tenant_id` é index obrigatório (e idealmente a coluna inicial de indexes compostos).
- `created_at DESC` é index frequente em listagens.
- Filtros parciais (`WHERE deleted_at IS NULL`) beneficiam de **partial indexes**.

## 6. Migrações são destrutivas até prova em contrário

Lê toda migração com a pergunta: *"o que acontece se isto correr contra a base de produção com tráfego ativo?"*

- `ALTER TABLE ... ADD COLUMN NOT NULL` sem `DEFAULT` → lock + reescrita da tabela
- `ALTER TABLE ... ALTER COLUMN TYPE` → reescrita
- `DROP COLUMN` → perda de dados permanente
- `DELETE FROM x WHERE ...` numa migração → revisão dupla
- `CREATE INDEX` sem `CONCURRENTLY` → lock de escrita

Toda migração de produção precisa de **rollback** documentado, mesmo que seja `-- não recuperável, restore from backup`.

## 7. Auth é uma cadeia, não um ponto

Validar "tem sessão" não chega. A cadeia certa:

1. **Sessão válida** (`auth.uid()` retorna não-nulo)
2. **Identidade verificada** (email confirmado se requerido)
3. **Membership** no recurso (organização, projeto)
4. **Role suficiente** (admin, member, viewer)
5. **Ownership específico** quando aplicável (este recurso é meu?)

Saltar passos = bug de autorização (IDOR, BOLA).

## 8. Storage é uma base de dados separada

`storage.objects` é uma tabela Postgres com RLS própria. Buckets públicos = `GET` para qualquer um.

- Bucket público é OK para: avatars, logos públicos, assets de marketing
- Bucket público NUNCA é OK para: invoices, contratos, documentos de utilizador, exports de dados

Path matters: `<org_id>/<user_id>/<file>` é necessário para policies por tenant via `(storage.foldername(name))[1]`.

## 9. Realtime é caro a escalar

Cada subscription é uma ligação WebSocket persistente + replicação lógica + filtro por linha. A 10k clientes:

- Cada UPDATE replicado é avaliado contra cada subscription
- Sem filtros, cada cliente recebe eventos de todos os tenants (e a RLS bloqueia, mas o custo de avaliação fica)
- Usar `filter` no `subscribe()` no cliente E nas policies no servidor

Não fazer realtime em tudo. Realtime para *colaboração ao vivo*; polling para tudo o resto.

## 10. Edge Functions são o lado "backend" do Supabase

Por defeito uma Edge Function não autentica nada. Quem chama tem `service_role` ou nada.

Padrão correto:
1. Aceitar JWT do utilizador no header `Authorization: Bearer <token>`
2. Criar cliente Supabase **com a chave do utilizador** para validar a sessão
3. Validar membership/ownership do recurso
4. Só então usar `service_role` se precisar de bypass RLS para uma operação específica

## Heurísticas rápidas

| Sinal | Interpretação | Severidade |
|---|---|---|
| `CREATE TABLE` sem `ENABLE ROW LEVEL SECURITY` | RLS missing | Crítico se dados de user |
| `USING (true)` | Policy sem restrição | Crítico se SELECT/INSERT/UPDATE/DELETE em dados sensíveis |
| `USING (auth.uid() = user_id)` em SaaS multi-tenant | Falta filtro de organização | Alto |
| FK sem index correspondente | Performance bomba | Médio→Alto consoante volume |
| `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE` | service_role exposto ao browser | Crítico |
| Bucket `public: true` + uploads do user | Risco de exfiltração | Alto→Crítico |
| Edge Function sem `Authorization` header | Endpoint anónimo | Alto se opera sobre dados |
| `CREATE INDEX` sem `CONCURRENTLY` em migração | Lock em prod | Alto |
| `ALTER ... NOT NULL` sem `DEFAULT` em tabela grande | Lock + rewrite | Alto |
| Subscriptions realtime sem `filter` | Custo + leak parcial | Médio→Alto |

## Postura de comunicação

- **Direto**: "Esta tabela não tem RLS. Qualquer utilizador autenticado pode ler tudo."
- **Sem dramatização**: evita "catastrófico", "vai ser hackeado". O facto é suficiente.
- **Com fix copy-paste**: cada problema vem com SQL pronto.
- **Com rollback**: cada DDL não-trivial inclui o inverso.
- **Com porquê arquitetural**: não basta dizer "adiciona um index". Explica *que query* fica rápida.
