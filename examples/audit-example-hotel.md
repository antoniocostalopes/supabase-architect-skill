# Example — SUPABASE_AUDIT.md (Hotel / Booking system)

Exemplo few-shot para sistema de reservas hoteleiras. Padrões únicos: disponibilidade temporal, conflitos de overlapping com `tstzrange` + GiST, multi-property (cada hotel é tenant), pricing dinâmico, cancelations.

---

```markdown
# SUPABASE_AUDIT — staycation-bookings

> Auditoria gerada por **Supabase Architect** em 2026-05-11.
> Stack: Next.js + Supabase + Stripe · Project: `stc987xyz`.
> Modelo: multi-property (cada hotel = `organization`; staff = `memberships`; guests = users globais).

## Sumário

- **Score**: 44 / 100 — Refactor estrutural necessário
- **Críticos**: 3 · **Altos**: 8 · **Médios**: 12 · **Baixos**: 6

## Modelo de dados

```
public.organizations (= hotel)
    │
    ├──N:M── public.memberships (staff: owner/manager/staff)
    │
    └──1:N── public.properties (edifício/unidade)
                 │
                 └──1:N── public.rooms
                              │
                              └──1:N── public.bookings (guest_id, range tstzrange)
                                   │
                                   └──1:N── public.booking_payments
```

## Achados destacados (únicos do domínio)

### [CRÍTICO · 95%] Double booking possível — sem constraint de exclusão temporal

- **Localização**: `supabase/migrations/20251210_bookings.sql`
- **Problema**: `bookings` tem `checkin_at`, `checkout_at` mas **nenhuma constraint** impede overlap. Duas reservas para o mesmo quarto na mesma noite são aceites simultaneamente.
- **Fix** com `EXCLUDE` constraint + GiST index:
  ```sql
  -- 1. Adicionar coluna range (calculada ou stored)
  ALTER TABLE public.bookings
    ADD COLUMN stay_range tstzrange
    GENERATED ALWAYS AS (tstzrange(checkin_at, checkout_at, '[)')) STORED;

  -- 2. EXCLUDE constraint (apenas bookings confirmadas/pendentes)
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      room_id WITH =,
      stay_range WITH &&
    ) WHERE (status IN ('confirmed', 'pending'));
  ```
- **Nota**: aplicar em janela de baixo tráfego e validar com `EXCLUDE ... DEFERRABLE INITIALLY DEFERRED` se houver migration de dados que precise da janela.

### [CRÍTICO · 95%] Staff de Hotel A vê bookings de Hotel B

- **Problema**: Policy de `bookings` filtra por `is_member` mas `bookings` não tem `organization_id` denormalizado — só `room_id → property_id → organization_id`.
- **Impacto**: JOIN policy resulta em scan + falha intermitente de RLS quando o planner escolhe ordem errada.
- **Fix**: denormalizar `organization_id` em `bookings`:
  ```sql
  ALTER TABLE public.bookings ADD COLUMN organization_id uuid;

  UPDATE public.bookings b SET organization_id = (
    SELECT p.organization_id FROM public.rooms r
    JOIN public.properties p ON p.id = r.property_id
    WHERE r.id = b.room_id
  );

  ALTER TABLE public.bookings
    ALTER COLUMN organization_id SET NOT NULL,
    ADD CONSTRAINT bookings_org_fk FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id) ON DELETE CASCADE;

  CREATE INDEX idx_bookings_org_stay ON public.bookings(organization_id, stay_range);

  -- Trigger para manter sincronizado
  CREATE OR REPLACE FUNCTION public.sync_booking_org()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    SELECT p.organization_id INTO NEW.organization_id
    FROM public.rooms r JOIN public.properties p ON p.id = r.property_id
    WHERE r.id = NEW.room_id;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER trg_bookings_sync_org
  BEFORE INSERT OR UPDATE OF room_id ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_org();
  ```

### [CRÍTICO · 90%] Guests acedem a bookings de outros guests

- **Problema**: Policy `bookings_select` permite o staff (correto) **e** qualquer authenticated com `guest_id IN (...)` mas subquery aceita lista vazia → match wildcard.
- **Fix**:
  ```sql
  CREATE POLICY "bookings_select_guest" ON public.bookings
  FOR SELECT TO authenticated
  USING (
    guest_id = auth.uid()
    OR public.is_member(organization_id)
  );
  ```

### [ALTO · 85%] Availability query usa OFFSET grande

- **Problema**: Frontend de calendário paginava com `OFFSET 30` para próximo mês. Em hotel grande (200+ quartos × N dias) → seq scan completo.
- **Fix** — RPC com range:
  ```sql
  CREATE OR REPLACE FUNCTION public.room_availability(
    target_property uuid,
    range_start timestamptz,
    range_end timestamptz
  ) RETURNS TABLE (room_id uuid, occupied_ranges tstzrange[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.id, coalesce(array_agg(b.stay_range) FILTER (WHERE b.id IS NOT NULL), '{}')
    FROM public.rooms r
    LEFT JOIN public.bookings b ON b.room_id = r.id
      AND b.status IN ('confirmed', 'pending')
      AND b.stay_range && tstzrange(range_start, range_end, '[)')
    WHERE r.property_id = target_property
      AND public.is_member(
        (SELECT organization_id FROM public.properties WHERE id = target_property)
      )
    GROUP BY r.id;
  $$;
  ```

### [ALTO · 80%] Cancelation policy não atómica

- **Problema**: Cancelation faz 3 operações separadas (UPDATE booking, INSERT refund, decrementar stock). Sem transação → estados inconsistentes em falha parcial.
- **Fix**: RPC atómica:
  ```sql
  CREATE OR REPLACE FUNCTION public.cancel_booking(
    booking_id uuid,
    reason text
  ) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE b record;
  BEGIN
    -- Lock booking
    SELECT * INTO b FROM public.bookings WHERE id = booking_id FOR UPDATE;

    -- Validar permissão
    IF b.guest_id != auth.uid() AND NOT public.has_role(b.organization_id, 'manager') THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    -- Atomic: marcar cancelada + criar refund
    UPDATE public.bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = reason
    WHERE id = booking_id;

    INSERT INTO public.booking_refunds (booking_id, amount, reason, requested_by)
    VALUES (booking_id, b.total_amount, reason, auth.uid());
  END;
  $$;
  ```

### [MÉDIO] pricing dinâmico via `pricing_rules` sem partial index

```sql
CREATE INDEX idx_pricing_rules_active
  ON public.pricing_rules(property_id, season_range)
  USING gist (property_id, season_range)
  WHERE is_active = true;
```

## Plano

### Fase 1 — Stop the bleeding (1 semana)
- [ ] EXCLUDE constraint para no_overlap
- [ ] Denormalizar `organization_id` em `bookings`
- [ ] Fix policy de guest access

### Fase 2 — Operacional (2-3 semanas)
- [ ] RPC `room_availability` com tstzrange queries
- [ ] RPC `cancel_booking` atómica
- [ ] Audit log de cancelations + refunds

### Fase 3 — Performance (1 mês)
- [ ] Partial indexes em pricing rules
- [ ] Materialized view `occupancy_by_property_month`
- [ ] Realtime apenas em `bookings` filtrado por property
```

---

## Notas — padrões únicos hotel/booking

- **Temporal exclusion**: usar `tstzrange` + `EXCLUDE USING gist` é o único caminho seguro para prevenir double-booking. Validação aplicativa não basta.
- **`btree_gist` extension** necessária para misturar uuid (`=`) com range (`&&`) no mesmo EXCLUDE.
- **Multi-property hierarchy**: `organizations → properties → rooms → bookings`. Denormalizar `organization_id` em `bookings` é não-negociável para performance de RLS.
- **Calendar queries** beneficiam de `tstzrange &&` (overlap) e indexes GiST, não BTREE.
- **Pricing dinâmico**: tabela `pricing_rules` com `season_range tstzrange` + partial index `WHERE is_active`.
- **Cancelation policies** (`cancel_at_least_X_days_before`) podem ser função: `public.is_refundable(booking_id) RETURNS boolean`.
