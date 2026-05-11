# Example — SUPABASE_AUDIT.md (Marketplace 2-sided)

Exemplo few-shot para marketplace com **dois lados** (sellers + buyers) e transações entre tenants. Padrões únicos: cross-tenant intencional via orders, escrow de pagamentos, dispute resolution, listings públicos vs privados.

---

```markdown
# SUPABASE_AUDIT — handmade-market

> Auditoria gerada por **Supabase Architect** em 2026-05-11.
> Stack: Next.js 14 (App Router) + Stripe Connect · Supabase project: `mkpqrs789`.
> Modelo: marketplace 2-sided (sellers como sub-tenants; buyers como users globais).

## Sumário executivo

- **Score**: 51 / 100 — Pre-produção
- **Críticos**: 3 · **Altos**: 6 · **Médios**: 9 · **Baixos**: 4

**Top 3 ações urgentes**:
1. RLS em `listings` permite seller A editar listings do seller B (policy só verifica `auth.role()`).
2. `payouts` table acessível a buyers — exposição de revenue dos sellers.
3. `order_messages` (chat buyer↔seller) lê do "outro lado" sem validação de participação na order.

## Modelo de dados

Diferente de SaaS: não há `memberships` simples. Há:

```
auth.users (todos: sellers + buyers + admin)
    │
    ├──1:1── public.profiles (visíveis publicamente)
    │
    ├──1:N── public.seller_accounts  (só quem vende)
    │            │
    │            └──1:N── public.listings  (produto à venda)
    │
    └──1:N── public.orders (buyer_id)
             │
             ├──N:M── public.order_items (FK listings + sellers)
             ├──1:N── public.order_messages (chat buyer↔seller da order)
             └──1:1── public.payouts (post-fulfillment, só seller vê)
```

**Padrão crítico**: orders ligam buyer (user) a múltiplos sellers (cada item pode ser de seller diferente). RLS tem de lidar com "tenho participação como buyer **OU** como seller dum dos items".

## Achados destacados (únicos do domínio)

### [CRÍTICO · 95%] Sellers podem editar listings uns dos outros

- **Localização**: `pg_policies` → `listings_update`
- **Policy atual**:
  ```sql
  CREATE POLICY "listings_update" ON public.listings
  FOR UPDATE TO authenticated USING (auth.role() = 'authenticated');
  ```
- **Impacto**: Qualquer seller faz update de listings de outro seller (preço, stock, descrição). Pode forçar venda a preço zero.
- **Fix**:
  ```sql
  DROP POLICY "listings_update" ON public.listings;

  CREATE POLICY "listings_update_own" ON public.listings
  FOR UPDATE TO authenticated
  USING (
    seller_account_id IN (
      SELECT id FROM public.seller_accounts WHERE owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    seller_account_id IN (
      SELECT id FROM public.seller_accounts WHERE owner_user_id = auth.uid()
    )
  );

  -- Index a suportar
  CREATE INDEX IF NOT EXISTS idx_seller_accounts_owner
    ON public.seller_accounts(owner_user_id);
  ```

### [CRÍTICO · 95%] `payouts` lê para qualquer authenticated user

- **Problema**: Tabela com totais de revenue por seller, sem filtro de ownership.
- **Fix**:
  ```sql
  CREATE POLICY "payouts_select_own_seller" ON public.payouts
  FOR SELECT TO authenticated
  USING (
    seller_account_id IN (
      SELECT id FROM public.seller_accounts WHERE owner_user_id = auth.uid()
    )
  );
  ```

### [CRÍTICO · 95%] Chat `order_messages` ignora participação na order

- **Problema**: User pode subscrever realtime a qualquer order e ler mensagens privadas.
- **Fix** (helper + policy):
  ```sql
  CREATE OR REPLACE FUNCTION public.is_order_participant(target_order uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = target_order
        AND (
          o.buyer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.order_items oi
            JOIN public.seller_accounts s ON s.id = oi.seller_account_id
            WHERE oi.order_id = o.id AND s.owner_user_id = auth.uid()
          )
        )
    );
  $$;

  CREATE POLICY "order_messages_select_participant" ON public.order_messages
  FOR SELECT TO authenticated USING (public.is_order_participant(order_id));

  CREATE POLICY "order_messages_insert_participant" ON public.order_messages
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = auth.uid() AND public.is_order_participant(order_id)
  );
  ```

### [ALTO · 90%] Listings privados leakam via FTS index público

- **Problema**: Listing com `status = 'draft'` (não publicado) aparece em `SELECT *` quando a policy filtra só por `is_deleted = false`.
- **Fix**:
  ```sql
  CREATE POLICY "listings_public_read" ON public.listings
  FOR SELECT TO anon, authenticated
  USING (status = 'published' AND deleted_at IS NULL);

  CREATE POLICY "listings_owner_read_all" ON public.listings
  FOR SELECT TO authenticated
  USING (
    seller_account_id IN (
      SELECT id FROM public.seller_accounts WHERE owner_user_id = auth.uid()
    )
  );
  ```

### [ALTO · 85%] Stock race condition

- **Problema**: 2 buyers compram simultaneamente, ambos veem `stock = 1`, ambos confirmam, stock fica em -1.
- **Fix** com lock pessimista no checkout:
  ```sql
  CREATE OR REPLACE FUNCTION public.checkout_order(order_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE item record;
  BEGIN
    FOR item IN
      SELECT oi.listing_id, oi.quantity
      FROM public.order_items oi
      WHERE oi.order_id = checkout_order.order_id
      FOR UPDATE  -- nada de SKIP LOCKED aqui — queremos esperar
    LOOP
      UPDATE public.listings
      SET stock = stock - item.quantity
      WHERE id = item.listing_id AND stock >= item.quantity;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END;
  $$;
  ```

### [ALTO] Stripe Connect webhook sem signature verification
Padrão crítico em marketplace. Ver `references/08-edge-functions-security.md`.

## Plano

### Fase 1 (24h)
- [ ] Reescrever policies de `listings`, `payouts`, `order_messages`
- [ ] Activar Stripe webhook signature
- [ ] Implementar `checkout_order` RPC com lock

### Fase 2 (1 semana)
- [ ] Dispute resolution table + policies (admin + participantes)
- [ ] Audit log de mudanças em payouts
- [ ] Rate limit em `order_messages` (anti-spam buyer→seller)

### Fase 3 (1 mês)
- [ ] FTS em listings com weighting (title > description)
- [ ] Materialized view `seller_dashboard` (revenue/30d)
```

---

## Notas — padrões únicos do marketplace

- **Não há `organization_id` único**: ownership é via `seller_accounts`. Cada listing pertence a um seller; cada order pertence a um buyer **mas** envolve N sellers.
- **Two-sided RLS**: helpers `is_seller(seller_id)` e `is_order_participant(order_id)` substituem o `is_member(org_id)` típico.
- **Listings públicos** (read sem auth) coexistem com **drafts privados** — duas policies SELECT no mesmo bucket.
- **Stock atomicity**: marketplace exige RPC com lock; não é seguro fazer `UPDATE listings SET stock = stock - 1` direto do cliente.
- **Stripe Connect** introduz `payouts`, KYC status do seller, schedule de transferências. Tudo isto via webhook seguro.
