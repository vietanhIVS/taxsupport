begin;

create type public.registration_status as enum ('SUBMITTED','NEEDS_QUOTE','AWAITING_PAYMENT','PROCESSING','COMPLETED','CANCELLED');
create type public.payment_status as enum ('NOT_REQUIRED','AWAITING_QUOTE','PENDING','CUSTOMER_REPORTED','VERIFIED','CANCELLED');
create type public.pricing_type as enum ('FIXED','FREE','MANUAL_QUOTE');

create table public.services (
  id text primary key check (id in ('TAX_REFUND','TAX_LOOKUP','OTHER')),
  name text not null check (length(name) between 1 and 100),
  description text not null check (length(description) between 1 and 500),
  short_code text not null unique,
  pricing_type public.pricing_type not null,
  fixed_fee bigint,
  is_active boolean not null default true,
  display_order integer not null,
  check ((id, short_code, pricing_type) in (('TAX_REFUND','HT','FIXED'),('TAX_LOOKUP','TC','FREE'),('OTHER','KH','MANUAL_QUOTE'))),
  check (case pricing_type
    when 'FIXED' then fixed_fee is not null and fixed_fee between 1 and 333333333333
    when 'FREE' then fixed_fee is not null and fixed_fee = 0
    when 'MANUAL_QUOTE' then fixed_fee is null end)
);
insert into public.services values
  ('TAX_REFUND','Hỗ trợ thủ tục hoàn thuế','Hướng dẫn chuẩn bị hồ sơ và thực hiện các bước đề nghị hoàn thuế thu nhập cá nhân.','HT','FIXED',300000,true,1),
  ('TAX_LOOKUP','Tra cứu thông tin thuế','Hỗ trợ tra cứu mã số thuế và thông tin nghĩa vụ thuế cá nhân.','TC','FREE',0,true,2),
  ('OTHER','Dịch vụ khác','Mô tả nhu cầu của bạn để nhận báo giá phù hợp trước khi thanh toán.','KH','MANUAL_QUOTE',null,true,3);

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('operator','owner')),
  is_active boolean not null default true
);
create table public.legal_config (
  singleton boolean primary key default true check (singleton),
  version text not null check (length(version) between 1 and 100),
  identity text not null check (length(trim(identity)) >= 5),
  privacy text not null check (length(trim(privacy)) >= 50),
  terms text not null check (length(trim(terms)) >= 50),
  contact text not null check (length(trim(contact)) >= 5),
  retention text not null check (length(trim(retention)) >= 5)
);
create table public.payment_config (
  singleton boolean primary key default true check (singleton),
  bank text not null check (length(trim(bank)) between 2 and 100),
  bin text check (bin ~ '^[0-9]{6}$'),
  account text not null check (account ~ '^[0-9]{6,19}$'),
  holder text check (length(trim(holder)) between 2 and 100),
  description_limit integer check (description_limit between 20 and 90),
  verified boolean not null default false,
  verified_by uuid,
  verified_at timestamptz,
  check (not verified or (verified_by is not null and verified_at is not null and bin is not null and holder is not null and description_limit is not null))
);

insert into public.payment_config(bank,account) values ('TPBank','0961015592');

create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique check (reference_code ~ '^TAX[A-Z0-9]{8}$'),
  full_name text not null,
  citizen_id_encrypted text not null,
  citizen_id_tail text not null check (citizen_id_tail ~ '^[0-9]{4}$'),
  email text not null,
  phone text not null,
  birth_year integer not null check (birth_year >= 1900),
  total_fee bigint check (total_fee between 0 and 999999999999),
  transfer_description text,
  registration_status public.registration_status not null,
  payment_status public.payment_status not null,
  consent_given boolean not null check (consent_given),
  consent_version text not null,
  consent_at timestamptz not null default now(),
  adult_confirmed boolean not null default false,
  idempotency_key uuid not null unique,
  request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((total_fee is null) = (payment_status = 'AWAITING_QUOTE') or registration_status = 'CANCELLED'),
  check ((total_fee > 0 and transfer_description is not null) or
         (coalesce(total_fee, 0) = 0 and transfer_description is null))
);
create index registrations_created_idx on public.registrations (created_at desc, id desc);
create index registrations_status_idx on public.registrations (registration_status, payment_status, created_at desc);
create index registrations_reference_prefix_idx on public.registrations (reference_code text_pattern_ops);

create table public.registration_services (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id) on delete cascade,
  service_id text not null references public.services(id),
  service_name_snapshot text not null,
  service_description_snapshot text not null,
  service_code_snapshot text not null,
  pricing_snapshot jsonb not null,
  calculated_fee bigint check (calculated_fee between 0 and 333333333333),
  additional_details text,
  unique (registration_id, service_id)
);
create index registration_services_service_idx on public.registration_services (service_id, registration_id);

create table public.payment_records (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references public.registrations(id) on delete cascade,
  expected_amount bigint not null check (expected_amount > 0),
  received_amount bigint,
  transaction_reference text unique,
  customer_reported_at timestamptz,
  verified_at timestamptz,
  verified_by uuid,
  beneficiary_snapshot jsonb not null,
  payload_version text not null default 'vietqr-napas-v1' check (payload_version = 'vietqr-napas-v1'),
  created_at timestamptz not null default now(),
  check ((verified_at is null and verified_by is null and received_amount is null and transaction_reference is null)
    or (verified_at is not null and verified_by is not null and received_amount is not null
        and received_amount = expected_amount and transaction_reference is not null))
);
create table public.audit_events (
  id bigint generated always as identity primary key,
  actor uuid,
  registration_id uuid references public.registrations(id) on delete set null,
  action text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_events_registration_idx on public.audit_events (registration_id, created_at desc);
create table public.rate_buckets (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket,window_start)
);
create index rate_buckets_window_idx on public.rate_buckets (window_start);

do $$
declare name text;
begin
  foreach name in array array['services','admins','legal_config','payment_config','registrations','registration_services','payment_records','audit_events','rate_buckets']
  loop
    execute format('alter table public.%I enable row level security', name);
    execute format('revoke all on public.%I from public, anon, authenticated', name);
    execute format('grant select, insert, update, delete on public.%I to service_role', name);
  end loop;
end;
$$;

create function public.ts_rate_limit(p_bucket text, p_limit int) returns boolean
language plpgsql set search_path = '' as $$
declare n integer; v_window timestamptz := date_trunc('minute',now());
begin
  if random() < 0.02 then
    delete from public.rate_buckets where window_start < v_window - interval '1 hour';
  end if;
  insert into public.rate_buckets as rb (bucket,window_start) values (p_bucket,v_window)
  on conflict (bucket,window_start) do update set hits = least(rb.hits+1, p_limit+1)
  returning hits into n;
  return n <= p_limit;
end;
$$;

create function public.ts_require_admin(p_actor uuid, p_owner boolean default false) returns text
language plpgsql stable set search_path = '' as $$
declare v_role text;
begin
  select role into v_role from public.admins where user_id = p_actor and is_active;
  if v_role is null or (p_owner and v_role <> 'owner') then
    raise exception using errcode='42501', message='DENIED';
  end if;
  return v_role;
end;
$$;

create function public.ts_payment_snapshot() returns jsonb
language plpgsql set search_path = '' as $$
declare v_snapshot jsonb;
begin
  select jsonb_build_object('bank',bank,'bin',bin,'account',account,'holder',holder,'description_limit',description_limit)
  into v_snapshot from public.payment_config where singleton and verified for share;
  if v_snapshot is null then
    raise exception using errcode='PT503', message='PAYMENT_UNAVAILABLE';
  end if;
  return v_snapshot;
end;
$$;

create function public.ts_registration_result(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'reference', r.reference_code, 'registration_status', r.registration_status,
    'payment_status', r.payment_status, 'total_fee', r.total_fee, 'transfer_description', r.transfer_description,
    'beneficiary', p.beneficiary_snapshot,
    'lines', coalesce((select jsonb_agg(to_jsonb(s) - array['id','registration_id','additional_details']
      order by array_position(array['HT','TC','KH'],s.service_code_snapshot))
      from public.registration_services s where s.registration_id=r.id), '[]'::jsonb)
  )
  from public.registrations r left join public.payment_records p on p.registration_id = r.id
  where r.id = p_id;
$$;

create function public.ts_register(p_key uuid, p_hash text, p_reference text, p_person jsonb,
  p_selections jsonb, p_expected jsonb, p_version text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_existing public.registrations%rowtype;
  v_service public.services%rowtype;
  v_item jsonb;
  v_expected jsonb;
  v_lines jsonb := '[]';
  v_id uuid;
  v_total bigint := 0;
  v_quote boolean := false;
  v_codes text;
  v_description text;
  v_beneficiary jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
  select * into v_existing from public.registrations where idempotency_key = p_key;
  if found then
    if v_existing.request_hash <> p_hash then raise exception using errcode='PT409', message='IDEMPOTENCY_MISMATCH'; end if;
    return public.ts_registration_result(v_existing.id);
  end if;

  perform 1 from public.legal_config where version = p_version for share;
  if not found then
    raise exception using errcode='PT409', message='CONSENT_CHANGED';
  end if;
  if jsonb_array_length(p_selections) not between 1 and 3
     or jsonb_array_length(p_selections) <> jsonb_array_length(p_expected) then
    raise exception using errcode='PT400', message='INVALID_SELECTION';
  end if;

  for v_item in select value from jsonb_array_elements(p_selections) order by value->>'service_id' loop
    select * into v_service from public.services where id = v_item->>'service_id' and is_active for share;
    select value into v_expected from jsonb_array_elements(p_expected) where value->>'service_id' = v_item->>'service_id';
    if v_service.id is null or v_expected is null or v_expected->>'name' is distinct from v_service.name
      or v_expected->>'description' is distinct from v_service.description
      or v_expected->>'pricing_type' is distinct from v_service.pricing_type::text
      or (v_expected->>'fixed_fee')::bigint is distinct from v_service.fixed_fee then
      raise exception using errcode='PT409', message='CATALOG_CHANGED';
    end if;
    v_quote := v_quote or v_service.pricing_type = 'MANUAL_QUOTE';
    v_total := v_total + coalesce(v_service.fixed_fee, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',v_service.id,'name',v_service.name,'description',v_service.description,'code',v_service.short_code,'type',v_service.pricing_type,
      'fee',v_service.fixed_fee,'details',v_item->>'additional_details'));
  end loop;
  if v_quote then v_total := null; end if;
  if v_total > 0 then
    select string_agg(value->>'code', ' ' order by array_position(array['HT','TC','KH'], value->>'code'))
      into v_codes from jsonb_array_elements(v_lines);
    v_description := p_reference || ' ' || v_codes;
    v_beneficiary := public.ts_payment_snapshot();
  end if;

  insert into public.registrations (reference_code, full_name, citizen_id_encrypted, citizen_id_tail, email, phone, birth_year, total_fee, transfer_description, registration_status, payment_status, consent_given, consent_version, adult_confirmed, idempotency_key, request_hash)
  values (p_reference, p_person->>'full_name', p_person->>'citizen_id_encrypted', p_person->>'citizen_id_tail', p_person->>'email', p_person->>'phone',
    (p_person->>'birth_year')::integer, v_total, v_description,
    (case when v_quote then 'NEEDS_QUOTE' when v_total > 0 then 'AWAITING_PAYMENT' else 'SUBMITTED' end)::public.registration_status,
    (case when v_quote then 'AWAITING_QUOTE' when v_total > 0 then 'PENDING' else 'NOT_REQUIRED' end)::public.payment_status,
    true, p_version, (p_person->>'adult_confirmed')::boolean, p_key, p_hash)
  returning id into v_id;

  insert into public.registration_services(registration_id,service_id,service_name_snapshot,service_description_snapshot,service_code_snapshot,pricing_snapshot,calculated_fee,additional_details)
  select v_id, value->>'id', value->>'name', value->>'description', value->>'code', jsonb_build_object('type',value->>'type','fixed_fee',value->'fee'),
    (value->>'fee')::bigint, nullif(value->>'details','') from jsonb_array_elements(v_lines);

  if v_total > 0 then
    insert into public.payment_records(registration_id,expected_amount,beneficiary_snapshot) values (v_id,v_total,v_beneficiary);
  end if;
  return public.ts_registration_result(v_id);
end;
$$;

create function public.ts_report_payment(p_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare r public.registrations%rowtype;
begin
  select * into r from public.registrations where id = p_id for update;
  if not found then raise exception using errcode='PT404', message='NOT_FOUND'; end if;
  if r.registration_status <> 'AWAITING_PAYMENT' and r.payment_status <> 'VERIFIED' then
    raise exception using errcode='PT409', message='INVALID_STATE';
  end if;
  if r.payment_status = 'PENDING' then
    update public.registrations set payment_status='CUSTOMER_REPORTED', updated_at=now() where id=p_id;
    update public.payment_records set customer_reported_at=now() where registration_id=p_id;
  elsif r.payment_status not in ('CUSTOMER_REPORTED','VERIFIED') then
    raise exception using errcode='PT409', message='INVALID_STATE';
  end if;
  return public.ts_registration_result(p_id);
end;
$$;

create function public.ts_confirm_quote(p_actor uuid, p_id uuid, p_prices jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare r public.registrations%rowtype; v_line_count integer; v_total bigint; v_description text; v_beneficiary jsonb;
begin
  perform public.ts_require_admin(p_actor);
  select * into r from public.registrations where id=p_id for update;
  if not found then raise exception using errcode='PT404', message='NOT_FOUND'; end if;
  if r.registration_status <> 'NEEDS_QUOTE' then raise exception using errcode='PT409', message='INVALID_STATE'; end if;

  select count(*) into v_line_count from public.registration_services where registration_id=p_id;
  if (select count(*) from jsonb_object_keys(p_prices)) <> v_line_count or exists (
    select 1 from public.registration_services where registration_id=p_id
      and (not (p_prices ? service_id) or (p_prices->>service_id)::bigint not between 0 and 333333333333
        or p_prices->>service_id is null)
  ) then raise exception using errcode='PT400', message='INVALID_QUOTE'; end if;

  update public.registration_services set calculated_fee=(p_prices->>service_id)::bigint where registration_id=p_id;
  select sum(calculated_fee), r.reference_code || ' ' || string_agg(service_code_snapshot,' ' order by array_position(array['HT','TC','KH'],service_code_snapshot))
    into v_total,v_description from public.registration_services where registration_id=p_id;
  if v_total > 0 then
    v_beneficiary := public.ts_payment_snapshot();
    insert into public.payment_records(registration_id,expected_amount,beneficiary_snapshot) values (p_id,v_total,v_beneficiary);
  else
    v_description := null;
  end if;
  update public.registrations set total_fee=v_total, transfer_description=v_description,
    registration_status=(case when v_total > 0 then 'AWAITING_PAYMENT' else 'SUBMITTED' end)::public.registration_status,
    payment_status=(case when v_total > 0 then 'PENDING' else 'NOT_REQUIRED' end)::public.payment_status,
    updated_at=now() where id=p_id;
  insert into public.audit_events(actor,registration_id,action,metadata) values (p_actor,p_id,'QUOTE_CONFIRMED',jsonb_build_object('prices',p_prices,'total',v_total));
  return public.ts_registration_result(p_id);
end;
$$;

create function public.ts_verify_payment(p_actor uuid, p_id uuid, p_amount bigint, p_transaction text) returns jsonb
language plpgsql set search_path = '' as $$
declare r public.registrations%rowtype; p public.payment_records%rowtype;
begin
  perform public.ts_require_admin(p_actor);
  select * into r from public.registrations where id=p_id for update;
  if not found then raise exception using errcode='PT404', message='NOT_FOUND'; end if;
  select * into p from public.payment_records where registration_id=p_id;
  if r.payment_status='VERIFIED' and p.received_amount=p_amount and p.transaction_reference=p_transaction then
    return public.ts_registration_result(p_id);
  end if;
  if r.registration_status <> 'AWAITING_PAYMENT' or r.payment_status not in ('PENDING','CUSTOMER_REPORTED') or p.id is null then
    raise exception using errcode='PT409', message='INVALID_STATE';
  end if;
  if p.expected_amount <> p_amount then
    insert into public.audit_events(actor,registration_id,action,metadata) values
      (p_actor,p_id,'PAYMENT_DISCREPANCY',jsonb_build_object('expected',p.expected_amount,'received',p_amount,'transaction_reference',p_transaction));
    return jsonb_build_object('discrepancy',true);
  end if;
  begin
    update public.payment_records set received_amount=p_amount, transaction_reference=p_transaction, verified_by=p_actor, verified_at=now() where id=p.id;
  exception when unique_violation then
    insert into public.audit_events(actor,registration_id,action) values (p_actor,p_id,'DUPLICATE_TRANSACTION');
    return jsonb_build_object('duplicate',true);
  end;
  update public.registrations set payment_status='VERIFIED', updated_at=now() where id=p_id;
  insert into public.audit_events(actor,registration_id,action) values (p_actor,p_id,'PAYMENT_VERIFIED');
  return public.ts_registration_result(p_id);
end;
$$;

create function public.ts_transition(p_actor uuid, p_id uuid, p_status public.registration_status) returns jsonb
language plpgsql set search_path = '' as $$
declare r public.registrations%rowtype;
begin
  perform public.ts_require_admin(p_actor);
  select * into r from public.registrations where id=p_id for update;
  if not found then raise exception using errcode='PT404', message='NOT_FOUND'; end if;
  if r.registration_status = p_status then return public.ts_registration_result(p_id); end if;
  if not (
    (p_status='PROCESSING' and r.registration_status in ('SUBMITTED','AWAITING_PAYMENT') and r.payment_status in ('VERIFIED','NOT_REQUIRED'))
    or (p_status='COMPLETED' and r.registration_status='PROCESSING' and r.payment_status in ('VERIFIED','NOT_REQUIRED'))
    or (p_status='CANCELLED' and r.registration_status not in ('COMPLETED','CANCELLED'))
  ) then raise exception using errcode='PT409', message='INVALID_STATE'; end if;

  update public.registrations set registration_status=p_status, updated_at=now(),
    payment_status=case when p_status='CANCELLED' and payment_status not in ('VERIFIED','NOT_REQUIRED')
      then 'CANCELLED'::public.payment_status else payment_status end where id=p_id;
  insert into public.audit_events(actor,registration_id,action,metadata) values
    (p_actor,p_id,'STATUS_CHANGED',jsonb_build_object('from',r.registration_status,'to',p_status));
  return public.ts_registration_result(p_id);
end;
$$;

create function public.ts_admin_audit(p_actor uuid, p_id uuid, p_action text) returns void
language plpgsql set search_path = '' as $$
begin
  if p_action not in ('UNMASK','EXPORT','LINK_ISSUED') then raise exception using errcode='PT400', message='INVALID_ACTION'; end if;
  perform public.ts_require_admin(p_actor, p_action in ('UNMASK','EXPORT'));
  insert into public.audit_events(actor,registration_id,action) values (p_actor,p_id,p_action);
end;
$$;

create function public.ts_update_service(p_actor uuid, p_service jsonb) returns public.services
language plpgsql set search_path = '' as $$
declare s public.services%rowtype;
begin
  perform public.ts_require_admin(p_actor, true);
  update public.services set name=p_service->>'name', description=p_service->>'description',
    fixed_fee=(p_service->>'fixed_fee')::bigint, is_active=(p_service->>'is_active')::boolean,
    display_order=(p_service->>'display_order')::integer where id=p_service->>'id' returning * into s;
  if not found then raise exception using errcode='PT404', message='NOT_FOUND'; end if;
  insert into public.audit_events(actor,action,metadata) values (p_actor,'CATALOG_CHANGED',jsonb_build_object('service_id',s.id));
  return s;
end;
$$;

create function public.ts_update_beneficiary(p_actor uuid, p_config jsonb) returns void
language plpgsql set search_path = '' as $$
declare v_verified boolean := (p_config->>'verified')::boolean;
begin
  perform public.ts_require_admin(p_actor, true);
  insert into public.payment_config(singleton,bank,bin,account,holder,description_limit,verified,verified_by,verified_at)
  values (true,p_config->>'bank',p_config->>'bin',p_config->>'account',p_config->>'holder',(p_config->>'description_limit')::integer,
    v_verified,case when v_verified then p_actor end,case when v_verified then now() end)
  on conflict (singleton) do update set bank=excluded.bank,bin=excluded.bin,account=excluded.account,holder=excluded.holder,
    description_limit=excluded.description_limit,verified=excluded.verified,verified_by=excluded.verified_by,verified_at=excluded.verified_at;
  insert into public.audit_events(actor,action,metadata) values (p_actor,'BENEFICIARY_CHANGED',jsonb_build_object('verified',v_verified));
end;
$$;

create function public.ts_metrics(p_actor uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  perform public.ts_require_admin(p_actor);
  return (select jsonb_build_object(
    'total',count(*), 'today',count(*) filter (where r.created_at >= date_trunc('day',now(),'Asia/Ho_Chi_Minh')),
    'free',count(*) filter (where r.total_fee=0), 'paid',count(*) filter (where r.total_fee>0),
    'quotes',count(*) filter (where registration_status='NEEDS_QUOTE'),
    'pending',count(*) filter (where payment_status in ('PENDING','CUSTOMER_REPORTED')),
    'verified',count(*) filter (where payment_status='VERIFIED'),
    'processing',count(*) filter (where registration_status='PROCESSING'),
    'completed',count(*) filter (where registration_status='COMPLETED'),
    'revenue',coalesce(sum(p.received_amount),0)
  ) from public.registrations r left join public.payment_records p on p.registration_id=r.id);
end;
$$;

do $$
declare signature regprocedure;
begin
  for signature in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and left(p.proname,3)='ts_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;
grant usage on sequence public.audit_events_id_seq to service_role;

commit;
