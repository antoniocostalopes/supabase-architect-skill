# Supabase Realtime — Patterns & Scaling

Quando usar, quando evitar, e como escalar.

## Os 3 mecanismos do Realtime

### 1. Postgres Changes
Reage a INSERT/UPDATE/DELETE em tabelas. Requer:
- Tabela na publication `supabase_realtime`
- Replica identity (default ou `FULL`)
- Cliente subscreve a um canal com filtros

### 2. Broadcast
Mensagens efémeras pub/sub entre clientes. Não persiste. Bom para typing indicators, cursores, presence-like effects.

### 3. Presence
Lista de utilizadores online num canal, com state. Ideal para "quem está a ver este documento".

## Quando usar realtime

| Caso | Mecanismo | Vale a pena |
|---|---|---|
| Chat em tempo real | Postgres Changes + Broadcast | Sim |
| Colaboração em documento | Broadcast + Presence | Sim |
| Notificações in-app | Postgres Changes (tabela `notifications`) | Sim |
| Dashboard com KPIs ao vivo | Postgres Changes em view agregada | Talvez (avaliar custo) |
| Audit log streaming | Polling ou logs externos | Não |
| Telemetria | Não (use serviço próprio) | Não |
| Eventos de webhook | Não | Não |
| Lista de orders com refresh | Polling | Não |

Regra: realtime para *colaboração visível ao utilizador*; polling para *frescura tolerante a delay de segundos*.

## Activar realtime em tabela

```sql
-- Adicionar à publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

-- Para receber payload completo em UPDATE/DELETE (não só PK):
ALTER TABLE public.messages REPLICA IDENTITY FULL;

-- Verificar:
SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

**Custo de `REPLICA IDENTITY FULL`**: cada UPDATE replica todas as colunas no WAL. Em tabelas grandes/com escrita alta, sobe o I/O significativamente.

## Postgres Changes — cliente

```ts
// Sempre com filtros server-side
const channel = supabase
  .channel(`messages:${chatId}`)
  .on(
    'postgres_changes',
    {
      event: '*',           // ou INSERT, UPDATE, DELETE
      schema: 'public',
      table: 'messages',
      filter: `chat_id=eq.${chatId}`,
    },
    (payload) => {
      // payload.new, payload.old, payload.eventType
    }
  )
  .subscribe()

// Cleanup
channel.unsubscribe()
```

### Filtros suportados
- `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`

Filtros são **avaliados no servidor antes** do RLS — primeira linha de defesa de custo.

### Combinação com RLS
A subscrição **respeita RLS**. Antes de despachar um evento, o servidor valida que o user tem SELECT na linha.

Implicação: se o user não pode ler a linha (RLS bloqueia), não recebe o evento. Não precisas de duplicar lógica de auth no filter. Mas continua a fazer sentido filtrar para reduzir avaliações.

## Broadcast — cliente

```ts
const channel = supabase.channel(`doc:${docId}`)

channel
  .on('broadcast', { event: 'cursor' }, ({ payload }) => {
    // mostrar cursor de outro user
  })
  .subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      // emitir
      await channel.send({
        type: 'broadcast',
        event: 'cursor',
        payload: { user: userId, x, y },
      })
    }
  })
```

### Authorization para Broadcast (importante)

Por defeito qualquer cliente subscreve qualquer canal. Para SaaS é insuficiente. Activar **Realtime Authorization** no Dashboard e definir policies em `realtime.messages`:

```sql
-- Permitir broadcast/presence apenas para canais da org do user
CREATE POLICY "doc_channel_org_members" ON realtime.messages
FOR SELECT TO authenticated
USING (
  -- topic format: doc:<doc_uuid>
  EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = (split_part(realtime.topic(), ':', 2))::uuid
      AND public.is_member(d.organization_id)
  )
);
```

Sem isto, broadcast é um leak de dados entre tenants.

## Presence — cliente

```ts
const channel = supabase.channel(`doc:${docId}`, {
  config: { presence: { key: userId } }
})

channel
  .on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState()
    // lista de users online
  })
  .on('presence', { event: 'join' }, ({ key, newPresences }) => {})
  .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {})
  .subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ name, avatar })
    }
  })
```

## Custos e limites

Realtime tem limites por plano (verificar no Dashboard):
- Connections concorrentes
- Messages por canal por segundo
- Channels por client
- Database changes events por segundo

Sintomas de sobrecarga:
- Eventos atrasados
- Disconnects + reconnects frequentes
- WebSocket errors

## Patterns de escalabilidade

### P1. Granularidade do canal
```ts
// MAU: 1 canal global → todos recebem tudo
supabase.channel('all-messages')

// MELHOR: 1 canal por escopo lógico (org, document, chat)
supabase.channel(`messages:org-${orgId}`)
supabase.channel(`doc:${docId}`)
```

### P2. Filter server-side, não client-side
```ts
// MAU: subscreve tudo, filtra na app
.on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
  (payload) => { if (payload.new.organization_id === myOrgId) ... })

// BOM:
.on('postgres_changes', {
  event: '*', schema: 'public', table: 'orders',
  filter: `organization_id=eq.${myOrgId}`
}, handler)
```

### P3. Tabela "notification" dedicada
Em vez de subscrever às tabelas de domínio (que sobem o WAL), criar tabela compacta:

```sql
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  payload jsonb,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications REPLICA IDENTITY DEFAULT;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_own" ON public.notifications
FOR SELECT TO authenticated USING (user_id = auth.uid());
```

Tabelas de domínio escrevem aqui via trigger. Realtime só vê esta tabela leve.

### P4. Debounce / coalesce
Para cursores ou typing, throttle do lado do cliente:

```ts
const throttledSend = throttle(payload => channel.send(...), 100)
```

### P5. Unsubscribe agressivo
Quando o utilizador sai da página/tab, fechar canais.

```ts
useEffect(() => {
  const ch = supabase.channel(...).subscribe()
  return () => { ch.unsubscribe() }
}, [...])
```

## Anti-patterns realtime

### A1. Subscribe sem filtro
```ts
// Cliente recebe eventos de todos os tenants
supabase.channel('orders')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, ...)
```

### A2. Realtime em tabelas grandes/write-heavy
`audit_logs`, `events`, `telemetry` → no realtime.

### A3. Esquecer policies em `realtime.messages` para broadcast/presence
Sem policies, qualquer um subscreve qualquer canal.

### A4. Confiar em payload do realtime sem revalidar
```ts
// Cliente recebe payload.new e usa diretamente
// ← mas pode ser manipulado se a policy estiver fraca
// Sempre revalidar com query autenticada para operações sensíveis.
```

### A5. Reconectar em loop sem backoff
Se a conexão falha, fazer reconexão com exponential backoff. A SDK já faz isto; não desativar.

## Checklist realtime

- [ ] Que tabelas estão em `pg_publication_tables` para `supabase_realtime`?
- [ ] São todas necessárias?
- [ ] Cada subscription tem `filter` server-side?
- [ ] Canais são por escopo (tenant/recurso) e não globais?
- [ ] `realtime.messages` tem policies para broadcast/presence multi-tenant?
- [ ] Cleanup de subscriptions ao unmount?
- [ ] Tabelas com `REPLICA IDENTITY FULL` são as estritamente necessárias?
- [ ] Tabela `notifications` separada para eventos transversais?

## Query diagnóstico

```sql
-- Tabelas em realtime
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';

-- Replica identity (default = só PK, full = todas colunas)
SELECT n.nspname, c.relname,
  CASE c.relreplident
    WHEN 'd' THEN 'default (PK only)'
    WHEN 'n' THEN 'nothing'
    WHEN 'f' THEN 'full'
    WHEN 'i' THEN 'using index'
  END AS replica_identity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN (SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime');
```
