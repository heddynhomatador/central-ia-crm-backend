import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const ident = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe test identifier');
  return '"' + value + '"';
};
const encode = (value) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
export async function engineDatabase() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table crm_ai_integrations(id uuid primary key,tenant_id uuid not null,active boolean default true);
    create table crm_ai_agents(id uuid primary key,tenant_id uuid not null,enabled boolean default true);
    create table crm_ai_leads(id uuid primary key default gen_random_uuid(), tenant_id uuid, integration_id uuid,
      external_ticket_id text,external_contact_id text,phone text,name text,source text,status text,
      assigned_external_user_id text,metadata jsonb default '{}',first_message_at timestamptz,last_message_at timestamptz,created_at timestamptz default now());
    create table crm_ai_opportunities(id uuid primary key default gen_random_uuid(),tenant_id uuid,integration_id uuid,
      external_ticket_id text,external_opportunity_id text,lead_id uuid,title text,pipeline_id text,stage_id text,assigned_external_user_id text,
      status text,value numeric,raw_data jsonb,updated_at timestamptz,unique(integration_id,external_ticket_id));
    create table crm_ai_ticket_context(id uuid primary key default gen_random_uuid(),tenant_id uuid,integration_id uuid,
      external_ticket_id text,role text,content text,metadata jsonb,created_at timestamptz default now());
    create table crm_ai_followup_policies(id uuid primary key, tenant_id uuid, agent_id uuid,enabled boolean,max_attempts integer,
      delays_minutes jsonb,messages jsonb,reset_attempts_on_reply boolean,transfer_after_last boolean,
      transfer_pipeline_id text,transfer_stage_id text,transfer_queue_id text,transfer_user_order jsonb);
  `);
  const migration = await readFile(new URL('../migrations/20260917_conversation_engine_v2.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration); // Idempotent installation.
  const db = {
    pg,
    async rpc(name, args) {
      try {
        const values = []; const parts = Object.entries(args).map(([key, value]) => {
          if (['p_ids', 'p_users'].includes(key)) {
            const placeholders = value.map((v) => { values.push(v); return '$' + values.length; });
            return ident(key) + ' => ARRAY[' + placeholders.join(',') + ']::' + (key === 'p_ids' ? 'uuid' : 'text') + '[]';
          }
          values.push(encode(value)); return ident(key) + ' => $' + values.length;
        });
        const result = await pg.query('select ' + ident(name) + '(' + parts.join(',') + ') as data', values);
        return { data: result.rows[0].data, error: null };
      } catch (error) { return { data: null, error }; }
    },
    from(table) {
      let op = 'select', payload, selected = '*', singular = false, optional = false, count = null, ordering = '', conflict;
      const filters = [];
      const q = {
        select(columns = '*') { selected = columns; return q; },
        insert(value) { op = 'insert'; payload = value; return q; },
        upsert(value, options) { op = 'insert'; payload = value; conflict = options; return q; },
        update(value) { op = 'update'; payload = value; return q; },
        eq(k, v) { filters.push([k, '=', v]); return q; }, neq(k, v) { filters.push([k, '<>', v]); return q; },
        gt(k, v) { filters.push([k, '>', v]); return q; }, gte(k, v) { filters.push([k, '>=', v]); return q; },
        lt(k, v) { filters.push([k, '<', v]); return q; }, lte(k, v) { filters.push([k, '<=', v]); return q; },
        is(k, v) { filters.push([k, 'is', v]); return q; },
        in(k, v) { filters.push([k, 'in', v]); return q; },
        order(k, options = {}) { ordering = ' order by ' + ident(k) + (options.ascending === false ? ' desc' : ' asc'); return q; },
        limit(n) { count = n; return q; },
        single() { singular = true; return q; }, maybeSingle() { singular = true; optional = true; return q; },
        async then(resolve, reject) {
          const values = []; const param = (v) => { values.push(encode(v)); return '$' + values.length; };
          try {
            let sql = op === 'select' ? 'select ' + (selected === '*' ? '*' : selected.split(',').map(ident).join(',')) + ' from ' + ident(table)
              : op === 'update' ? 'update ' + ident(table) + ' set ' + Object.entries(payload).filter(([, v]) => v !== undefined).map(([k, v]) => ident(k) + '=' + param(v)).join(',')
                : 'insert into ' + ident(table) + '(' + Object.keys(payload).map(ident).join(',') + ') values (' + Object.values(payload).map(param).join(',') + ')';
            if (filters.length) sql += ' where ' + filters.map(([k, operator, value]) => operator === 'is' && value == null ? ident(k) + ' is null'
              : operator === 'in' ? ident(k) + ' in (' + value.map(param).join(',') + ')' : ident(k) + operator + param(value)).join(' and ');
            if (op === 'insert' && conflict) sql += ' on conflict (' + conflict.onConflict.split(',').map(ident).join(',') + ') do nothing';
            sql += op === 'select' ? ordering + (count != null ? ' limit ' + Number(count) : '') : ' returning *';
            const { rows } = await pg.query(sql, values);
            if (singular && (rows.length > 1 || (!optional && rows.length !== 1))) throw new Error('Expected single row');
            return resolve({ data: singular ? rows[0] || null : rows, error: null });
          } catch (error) { return resolve({ data: null, error }); }
        },
      };
      return q;
    },
  };
  return db;
}
export async function seedScope(db, ticket = '123', phone = '5511000000000') {
  const tenant = randomUUID(), integration = randomUUID(), agent = randomUUID();
  await db.pg.query('insert into crm_ai_integrations(id,tenant_id) values($1,$2)', [integration, tenant]);
  await db.pg.query('insert into crm_ai_agents(id,tenant_id) values($1,$2)', [agent, tenant]);
  return { tenant_id: tenant, integration_id: integration, agent_id: agent, ticket_id: ticket, contact_id: '456',
    external_event_id: randomUUID(), current_message: { text: 'Olá', type: 'text', from_customer: true },
    metadata: { phone, channel_id: '1', contact_name: 'Cliente', channel_type: 'waba', engine_mode: 'v2' },
    ticket_context: { status: 'pending' }, quoted_message: null, ad_context: null };
}
export async function makeDue(db) {
  await db.pg.exec("update crm_ai_turns set available_at=now()-interval '1 second'");
}
