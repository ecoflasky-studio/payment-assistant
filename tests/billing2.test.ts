/**
 * 第十二轮：PIX 年付、AI 加量包、App Store / Google Play 内购、删除账号
 * 运行真实 setup.sql（PGlite）+ 打包后的 Supabase 函数；苹果 / 谷歌 / Mercado Pago 接口为模拟。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore 打包后的 Supabase 函数
import { serve } from '../supabase/functions/recognize/index.ts';
// @ts-ignore
import { createPostgrest } from './support/postgrest.mjs';
import fixture from './fixtures/ticket-258.model.json';

const SB = 'https://proj.supabase.co';
const MPAPI = 'https://mp.test';
const GEM = 'https://gem.test/v1beta';
const APPLE = 'https://apple.test';
const APPLE_SB = 'https://apple-sandbox.test';
const GAPI = 'https://gplay.test';
const GTOKEN = 'https://oauth.test/token';
const PUB = 'sb_publishable_TEST_0123456789abcdef';
const SECRET = 'sb_secret_TEST_0123456789abcdef';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const TOKENS: Record<string, { id: string; email: string }> = { 'jwt-u1': { id: U1, email: 'ana@example.com' }, 'jwt-u2': { id: U2, email: 'bia@example.com' }, 'jwt-u3': { id: U3, email: 'cris@example.com' } };

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA = { client_email: 'play@proj.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), private_key_id: 'k1' };
const jws = (o: unknown) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(o)).toString('base64url')}.sig`;
const verifyJwt = (token: string, key: crypto.KeyObject, alg: 'ES256' | 'RS256') => {
  const [h, p, s] = token.split('.');
  const ok = alg === 'ES256' ? crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')) : crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
};

let pg: PGlite;
let rest: ReturnType<typeof createPostgrest>;
const NOW = Date.now();
const day = 86400000;
// 模拟数据
const payments = new Map<string, any>();
const appleTx = new Map<string, any>(); // transactionId → { env, tx, status?, renewal? }
const gSubs = new Map<string, any>();
const gProducts = new Map<string, any>();
const calls: string[] = [];
let deletedUsers: string[] = [];

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init.headers);
  const body = init.body as string | undefined;
  const json = (status: number, obj: unknown) => new Response(obj === undefined ? '' : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith(`${SB}/auth/v1/admin/users/`)) {
    if (headers.get('apikey') !== SECRET) return json(401, {});
    const id = url.split('/').pop()!;
    await pg.query('delete from auth.users where id = $1', [id]);
    deletedUsers.push(id);
    return json(200, {});
  }
  if (url.startsWith(`${SB}/auth/v1/user`)) {
    const t = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const u = TOKENS[t];
    return u ? json(200, { id: u.id, email: u.email }) : json(401, { msg: 'invalid JWT' });
  }
  if (url.startsWith(`${SB}/rest/v1/`)) {
    const key = headers.get('apikey');
    const bearer = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const role = key === SECRET ? 'service' : TOKENS[bearer] ? 'user' : 'anon';
    const r = await rest({ method: init.method || 'GET', path: url.slice(SB.length), body, role, sub: TOKENS[bearer]?.id ?? null, prefer: headers.get('prefer') || '' });
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith(GEM)) return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }] }, finishReason: 'STOP' }] });
  if (url.startsWith(MPAPI)) {
    const path = url.slice(MPAPI.length);
    calls.push(`mp ${init.method || 'GET'} ${path}`);
    if (path === '/checkout/preferences') {
      const b = JSON.parse(body!);
      return json(201, { id: 'pref1', init_point: `https://mp.test/pay/${b.items[0].id}`, external_reference: b.external_reference, _body: b });
    }
    const m = path.match(/^\/v1\/payments\/(\w+)$/);
    if (m && payments.has(m[1])) return json(200, payments.get(m[1]));
    return json(404, { message: 'not found' });
  }
  if (url.startsWith(APPLE) || url.startsWith(APPLE_SB)) {
    const env = url.startsWith(APPLE_SB) ? 'Sandbox' : 'Production';
    const auth = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const claims = verifyJwt(auth, ec.publicKey, 'ES256');
    if (!claims || claims.aud !== 'appstoreconnect-v1' || claims.bid !== 'com.test.zq' || claims.iss !== 'issuer-1') return json(401, {});
    calls.push(`apple ${env} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    const m = url.match(/\/inApps\/v1\/(transactions|subscriptions)\/(\w+)$/);
    const rec = m && appleTx.get(m[2]);
    if (!rec || rec.env !== env) return json(404, { errorCode: 4040010 });
    if (m![1] === 'transactions') return json(200, { signedTransactionInfo: jws(rec.tx) });
    return json(200, { data: [{ subscriptionGroupIdentifier: 'g1', lastTransactions: [{ originalTransactionId: rec.tx.originalTransactionId, status: rec.status, signedTransactionInfo: jws(rec.tx), signedRenewalInfo: jws(rec.renewal ?? { autoRenewStatus: 1 }) }] }] });
  }
  if (url === GTOKEN) {
    const assertion = new URLSearchParams(body!).get('assertion')!;
    const claims = verifyJwt(assertion, rsa.publicKey, 'RS256');
    if (!claims || claims.iss !== SA.client_email || !String(claims.scope).includes('androidpublisher')) return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: 'g-access', expires_in: 3600 });
  }
  if (url.startsWith(GAPI)) {
    if (headers.get('authorization') !== 'Bearer g-access') return json(401, {});
    const path = decodeURIComponent(url.slice(GAPI.length).replace('/androidpublisher/v3/applications/com.test.zq', ''));
    calls.push(`google ${init.method || 'GET'} ${path}`);
    let m = path.match(/^\/purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) return gSubs.has(m[1]) ? json(200, gSubs.get(m[1])) : json(404, {});
    m = path.match(/^\/purchases\/subscriptions\/(.+)\/tokens\/(.+):acknowledge$/);
    if (m) {
      gSubs.get(m[2]).acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      return json(200, {});
    }
    m = path.match(/^\/purchases\/products\/(.+)\/tokens\/(.+?)(:consume)?$/);
    if (m) {
      const p = gProducts.get(m[2]);
      if (!p) return json(404, {});
      if (m[3]) p.consumptionState = 1;
      return json(200, m[3] ? {} : p);
    }
    return json(404, {});
  }
  throw new Error(`unexpected fetch ${url}`);
}

const ENV = (extra: Record<string, string> = {}) => ({
  SUPABASE_URL: SB,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUB }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  GEMINI_API_KEY: 'g-secret',
  GEMINI_API_URL: GEM,
  GEMINI_FALLBACK_MODELS: '',
  RECOGNIZE_VERIFY: 'off',
  RATE_PER_MIN: '100',
  MP_API_URL: MPAPI,
  MP_ACCESS_TOKEN: 'TEST-mp-token',
  APPLE_BUNDLE_ID: 'com.test.zq',
  APPLE_ISSUER_ID: 'issuer-1',
  APPLE_KEY_ID: 'KEY123',
  APPLE_PRIVATE_KEY: P8,
  APPLE_API_URL: APPLE,
  APPLE_SANDBOX_API_URL: APPLE_SB,
  GOOGLE_PACKAGE_NAME: 'com.test.zq',
  GOOGLE_SERVICE_ACCOUNT: JSON.stringify(SA),
  GOOGLE_API_URL: GAPI,
  GOOGLE_TOKEN_URL: GTOKEN,
  GOOGLE_RTDN_TOKEN: 'rtdn-secret',
  ...extra,
});
const F = `${SB}/functions/v1/recognize`;
const call = (path: string, { token, body }: { token?: string; body?: unknown } = {}) =>
  serve(new Request(F + path, { method: body === undefined ? 'GET' : 'POST', headers: { apikey: PUB, origin: 'capacitor://localhost', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), ENV());
const me = async (token: string) => (await call('/me', { token })).json();
const recognize = (token: string) => call('', { token, body: { mediaType: 'image/png', imageBase64: Buffer.from('89504e47', 'hex').toString('base64') } });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
  await pg.exec(readFileSync('supabase/setup.sql', 'utf8'));
  await pg.query(`insert into auth.users(id, email) values ($1, 'ana@example.com'), ($2, 'bia@example.com'), ($3, 'cris@example.com')`, [U1, U2, U3]);
  rest = createPostgrest(pg);
  vi.stubGlobal('fetch', fakeFetch);
  for (const t of Object.keys(TOKENS)) await call('/me', { token: t });
});
afterAll(() => vi.unstubAllGlobals());

describe('网页版一次性付款（Mercado Pago：PIX / 卡）', () => {
  it('AI 加量包：付款通知 → 回 MP 查已批准 → +20 次；重复通知不重复入账；月度额度用完后自动使用', async () => {
    const r = await call('/billing/once', { token: 'jwt-u1', body: { kind: 'ai_pack', returnUrl: 'https://app.github.io/zq/?mp=1' } });
    expect(await r.json()).toEqual({ url: 'https://mp.test/pay/ai_pack' });
    payments.set('900', { id: 900, status: 'approved', external_reference: `${U1}|pack|ai`, transaction_amount: 4.9 });
    for (let i = 0; i < 2; i++) expect((await call('/billing/webhook', { body: { type: 'payment', data: { id: '900' } } })).status).toBe(200);
    expect((await me('jwt-u1')).usage.bonus).toBe(20);
    // 用完试用期 10 次后，从加量包扣
    await pg.query(`update zq_usage set ai = 10 where user_id = $1`, [U1]);
    await pg.query(`insert into zq_usage(user_id, month, ai) values ($1, 'trial', 10) on conflict (user_id, month) do update set ai = 10`, [U1]);
    const ok = await recognize('jwt-u1');
    expect(ok.status).toBe(200);
    expect((await ok.json()).usage).toMatchObject({ fromBonus: true });
    expect((await me('jwt-u1')).usage.bonus).toBe(19);
  });
  it('退款：扣回剩余加量次数', async () => {
    payments.set('900', { ...payments.get('900'), status: 'refunded' });
    await call('/billing/webhook', { body: { type: 'payment', data: { id: '900' } } });
    expect((await me('jwt-u1')).usage.bonus).toBe(0);
    const r = await recognize('jwt-u1');
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/AI 加量包/);
  });
  it('PIX 年付 T1：开通 1 年；再付一次从到期日顺延', async () => {
    const r = await call('/billing/once', { token: 'jwt-u2', body: { kind: 'pix_year', plan: 't1', returnUrl: 'https://app.github.io/zq/?mp=1' } });
    expect((await r.json()).url).toBe('https://mp.test/pay/pix_year');
    payments.set('901', { id: 901, status: 'approved', external_reference: `${U2}|pix|t1|year`, transaction_amount: 79.9 });
    await call('/billing/webhook', { body: { type: 'payment', data: { id: '901' } } });
    let m = await me('jwt-u2');
    expect(m).toMatchObject({ plan: 't1', period: 'year', source: 'pix', autoRenew: false, features: { push: true } });
    const until1 = Date.parse(m.planUntil);
    expect(Math.round((until1 - NOW) / day)).toBe(365);
    payments.set('902', { id: 902, status: 'approved', external_reference: `${U2}|pix|t1|year`, transaction_amount: 79.9 });
    await call('/billing/webhook', { body: { type: 'payment', data: { id: '902' } } });
    m = await me('jwt-u2');
    expect(Math.round((Date.parse(m.planUntil) - NOW) / day)).toBe(730);
    expect((await call('/billing/once', { token: 'jwt-u2', body: { kind: 'pix_year', plan: 't9', returnUrl: 'https://x.test/' } })).status).toBe(400);
  });
});

describe('App Store 内购', () => {
  it('订阅 T2 月付：按交易 ID 回苹果查（正式找不到 → 沙盒），账号标识必须是本人', async () => {
    appleTx.set('2000001', { env: 'Sandbox', status: 1, tx: { transactionId: '2000001', originalTransactionId: '1000001', productId: 'zq.t2.monthly', bundleId: 'com.test.zq', appAccountToken: U3, expiresDate: NOW + 30 * day, type: 'Auto-Renewable Subscription' } });
    // 别人的账号不能用这笔交易
    expect((await call('/iap/verify', { token: 'jwt-u1', body: { store: 'apple', transactionId: '2000001' } })).status).toBe(400);
    const r = await call('/iap/verify', { token: 'jwt-u3', body: { store: 'apple', transactionId: '2000001' } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.results[0]).toMatchObject({ kind: 'sub', status: 'active', plan: 't2', period: 'month' });
    expect(j.me).toMatchObject({ plan: 't2', source: 'apple', autoRenew: true, features: { export: true }, appAccountToken: U3 });
    expect(calls).toContain('apple Production /inApps/v1/transactions/2000001');
    expect(calls).toContain('apple Sandbox /inApps/v1/subscriptions/2000001');
  });
  it('服务器通知：关闭自动续费 → 状态以苹果 API 为准；过期 → 权限结束', async () => {
    appleTx.get('2000001').renewal = { autoRenewStatus: 0 };
    const payload = { notificationType: 'DID_CHANGE_RENEWAL_STATUS', data: { bundleId: 'com.test.zq', signedTransactionInfo: jws({ transactionId: '2000001', originalTransactionId: '1000001', bundleId: 'com.test.zq' }) } };
    expect((await call('/iap/apple', { body: { signedPayload: jws(payload) } })).status).toBe(200);
    let m = await me('jwt-u3');
    expect(m).toMatchObject({ plan: 't2', autoRenew: false });
    expect(m.subs[0]).toMatchObject({ source: 'apple', status: 'canceled' });
    appleTx.get('2000001').status = 2;
    appleTx.get('2000001').tx.expiresDate = NOW - day;
    await call('/iap/apple', { body: { signedPayload: jws({ ...payload, notificationType: 'EXPIRED' }) } });
    m = await me('jwt-u3');
    expect(m.plan).toBe('trial');
    // 伪造的通知（别的 App）被忽略
    expect(await (await call('/iap/apple', { body: { signedPayload: jws({ data: { signedTransactionInfo: jws({ transactionId: '1', bundleId: 'com.evil' }) } }) } })).json()).toEqual({ ignored: true });
  });
  it('AI 加量包（消耗型）：入账一次；苹果退款通知 → 扣回', async () => {
    appleTx.set('3000001', { env: 'Production', tx: { transactionId: '3000001', originalTransactionId: '3000001', productId: 'zq.ai20', bundleId: 'com.test.zq', appAccountToken: U3, quantity: 1, price: 4900 } });
    for (let i = 0; i < 2; i++) await call('/iap/verify', { token: 'jwt-u3', body: { store: 'apple', transactionId: '3000001' } });
    expect((await me('jwt-u3')).usage.bonus).toBe(20);
    appleTx.get('3000001').tx.revocationDate = NOW;
    await call('/iap/apple', { body: { signedPayload: jws({ notificationType: 'REFUND', data: { signedTransactionInfo: jws({ transactionId: '3000001', bundleId: 'com.test.zq' }) } }) } });
    expect((await me('jwt-u3')).usage.bonus).toBe(0);
  });
});

describe('Google Play 内购', () => {
  it('订阅 T1 年付：服务账号换令牌 → 查 subscriptionsv2 → 开通并确认（acknowledge）', async () => {
    gSubs.set('tok-1', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', externalAccountIdentifiers: { obfuscatedExternalAccountId: U1 }, lineItems: [{ productId: 'zq_t1', expiryTime: new Date(NOW + 365 * day).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: 'yearly' } }] });
    const r = await call('/iap/verify', { token: 'jwt-u1', body: { store: 'google', productId: 'zq_t1', purchaseToken: 'tok-1' } });
    expect(r.status).toBe(200);
    expect((await r.json()).me).toMatchObject({ plan: 't1', period: 'year', source: 'google', autoRenew: true });
    expect(gSubs.get('tok-1').acknowledgementState).toBe('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
  });
  it('实时通知：口令不对拒绝；升级到 T2 → 旧令牌作废', async () => {
    const note = (o: unknown) => ({ message: { data: Buffer.from(JSON.stringify({ packageName: 'com.test.zq', ...o as object })).toString('base64') } });
    expect((await call('/iap/google?token=bad', { body: note({}) })).status).toBe(401);
    gSubs.set('tok-2', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', linkedPurchaseToken: 'tok-1', externalAccountIdentifiers: { obfuscatedExternalAccountId: U1 }, lineItems: [{ productId: 'zq_t2', expiryTime: new Date(NOW + 30 * day).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: 'monthly' } }] });
    expect((await call('/iap/google?token=rtdn-secret', { body: note({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok-2', subscriptionId: 'zq_t2' } }) })).status).toBe(200);
    const m = await me('jwt-u1');
    expect(m).toMatchObject({ plan: 't2', period: 'month' });
    expect(m.subs.find((x: any) => x.plan === 't1').status).toBe('expired');
  });
  it('AI 加量包：入账并在服务器端消耗（consume）；作废通知 → 扣回', async () => {
    gProducts.set('ptok-1', { purchaseState: 0, consumptionState: 0, orderId: 'GPA.1', obfuscatedExternalAccountId: U1, quantity: 1 });
    await call('/iap/verify', { token: 'jwt-u1', body: { store: 'google', productId: 'zq_ai20', purchaseToken: 'ptok-1' } });
    expect((await me('jwt-u1')).usage.bonus).toBe(20);
    expect(gProducts.get('ptok-1').consumptionState).toBe(1);
    const note = { message: { data: Buffer.from(JSON.stringify({ packageName: 'com.test.zq', voidedPurchaseNotification: { purchaseToken: 'ptok-1', orderId: 'GPA.1', productType: 2 } })).toString('base64') } };
    await call('/iap/google?token=rtdn-secret', { body: note });
    expect((await me('jwt-u1')).usage.bonus).toBe(0);
  });
});

describe('删除账号', () => {
  it('需要输入邮箱确认；删除后账单、订阅、账号都不在了，并提醒去商店取消自动续费', async () => {
    await pg.query(`insert into zq_spaces(space, secret_hash) values ('u:${U1}', 'account') on conflict do nothing`);
    await pg.query(`insert into zq_records(space, kind, id, data, updated_at) values ('u:${U1}', 'bill', 'b1', '{}', now())`);
    expect((await call('/account/delete', { token: 'jwt-u1', body: { confirm: 'x@y.z' } })).status).toBe(400);
    const r = await call('/account/delete', { token: 'jwt-u1', body: { confirm: 'ana@example.com' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, cancelInStore: ['google'] });
    expect(deletedUsers).toEqual([U1]);
    for (const t of ['zq_profiles', 'zq_subs', 'zq_purchases', 'zq_usage']) expect((await pg.query(`select count(*)::int n from ${t} where user_id = $1`, [U1])).rows[0]).toEqual({ n: 0 });
    expect((await pg.query(`select count(*)::int n from zq_records where space = $1`, [`u:${U1}`])).rows[0]).toEqual({ n: 0 });
  });
});
