/**
 * App Store / Google Play 内购的服务端校验（只用 WebCrypto + fetch，可在 Deno / Node 运行）。
 *
 * 原则：不信任客户端或通知里的内容，一律用我们自己的凭证去苹果 / 谷歌官方 API 查真实状态。
 *  - Apple：App Store Server API（JWT ES256，In-App Purchase 密钥 .p8）
 *      GET /inApps/v1/transactions/{transactionId}        单笔交易（含消耗型）
 *      GET /inApps/v1/subscriptions/{transactionId}       订阅状态 + 续订信息
 *    先查正式环境，找不到再查沙盒（TestFlight / 审核时用沙盒）。
 *  - Google：Android Publisher API（服务账号 JWT RS256 → OAuth 访问令牌）
 *      purchases.subscriptionsv2.get / subscriptions.acknowledge
 *      purchases.products.get / products.consume
 */

const enc = new TextEncoder();
const b64u = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uJson = (o) => b64u(enc.encode(JSON.stringify(o)));
function unb64u(s) {
  const p = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** 解出 JWS 的内容（不校验签名：只用于来自官方 API 的响应，或拿来作为再次查询的线索） */
export function decodeJws(jws) {
  if (typeof jws !== 'string') return null;
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
  } catch {
    return null;
  }
}

function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return unb64u(body.replace(/\+/g, '-').replace(/\//g, '_'));
}

export async function signJwt(alg, pem, header, payload) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const input = `${b64uJson({ alg, typ: 'JWT', ...header })}.${b64uJson(payload)}`;
  const sig = await crypto.subtle.sign(alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }, key, enc.encode(input));
  return `${input}.${b64u(sig)}`;
}

export class StoreError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ Apple */

export function appleConfigured(c) {
  return !!(c.apple.bundleId && c.apple.issuer && c.apple.keyId && c.apple.key);
}

export function createApple(c, fetchImpl, now = () => new Date()) {
  let cached = { token: '', exp: 0 };
  async function token() {
    const t = Math.floor(now().getTime() / 1000);
    if (cached.token && cached.exp - 60 > t) return cached.token;
    const jwt = await signJwt('ES256', c.apple.key, { kid: c.apple.keyId }, { iss: c.apple.issuer, iat: t, exp: t + 1200, aud: 'appstoreconnect-v1', bid: c.apple.bundleId });
    cached = { token: jwt, exp: t + 1200 };
    return jwt;
  }
  async function get(path) {
    if (!appleConfigured(c)) throw new StoreError(503, '还没配置 App Store 内购校验（APPLE_* 密钥）', 'store_off');
    const auth = { authorization: `Bearer ${await token()}` };
    // 先正式环境，找不到再沙盒
    for (const base of [c.apple.api, c.apple.sandbox]) {
      const r = await fetchImpl(`${base}${path}`, { headers: auth });
      if (r.status === 404) continue;
      const text = await r.text();
      if (!r.ok) throw new StoreError(502, `App Store 校验失败（${r.status}）`, 'store_error');
      return { data: JSON.parse(text), sandbox: base === c.apple.sandbox };
    }
    throw new StoreError(404, '在 App Store 找不到这笔交易', 'not_found');
  }
  return {
    /** 单笔交易 */
    async transaction(transactionId) {
      const { data, sandbox } = await get(`/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
      const tx = decodeJws(data.signedTransactionInfo);
      if (!tx) throw new StoreError(502, 'App Store 返回的交易无法解析');
      if (tx.bundleId && tx.bundleId !== c.apple.bundleId) throw new StoreError(400, '交易不属于这个 App', 'wrong_app');
      return { ...tx, sandbox };
    },
    /** 订阅当前状态：status 1 有效 2 过期 3 扣款重试 4 宽限期 5 已撤销 */
    async subscription(transactionId) {
      const { data } = await get(`/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`);
      let best = null;
      for (const g of data.data ?? []) {
        for (const lt of g.lastTransactions ?? []) {
          const tx = decodeJws(lt.signedTransactionInfo);
          const ri = decodeJws(lt.signedRenewalInfo);
          if (!tx) continue;
          const item = { status: lt.status, originalTransactionId: lt.originalTransactionId ?? tx.originalTransactionId, tx, renewal: ri };
          if (!best || (tx.expiresDate ?? 0) > (best.tx.expiresDate ?? 0)) best = item;
        }
      }
      if (!best) throw new StoreError(404, '找不到订阅状态', 'not_found');
      return best;
    },
  };
}

export const APPLE_STATUS = { 1: 'active', 2: 'expired', 3: 'expired', 4: 'grace', 5: 'revoked' };

/* ------------------------------------------------------------------ Google */

export function googleConfigured(c) {
  return !!(c.google.packageName && c.google.account?.client_email && c.google.account?.private_key);
}

export function createGoogle(c, fetchImpl, now = () => new Date()) {
  let cached = { token: '', exp: 0 };
  async function token() {
    const t = Math.floor(now().getTime() / 1000);
    if (cached.token && cached.exp - 60 > t) return cached.token;
    const sa = c.google.account;
    const assertion = await signJwt('RS256', sa.private_key, sa.private_key_id ? { kid: sa.private_key_id } : {}, {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: c.google.tokenUrl,
      iat: t,
      exp: t + 3600,
    });
    const r = await fetchImpl(c.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new StoreError(502, `Google 服务账号登录失败（${r.status}）`, 'store_error');
    cached = { token: j.access_token, exp: t + Number(j.expires_in || 3600) };
    return cached.token;
  }
  async function call(method, path) {
    if (!googleConfigured(c)) throw new StoreError(503, '还没配置 Google Play 内购校验（GOOGLE_* 密钥）', 'store_off');
    const r = await fetchImpl(`${c.google.api}/androidpublisher/v3/applications/${encodeURIComponent(c.google.packageName)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    const text = await r.text();
    if (r.status === 404 || r.status === 410) throw new StoreError(404, '在 Google Play 找不到这笔购买', 'not_found');
    if (!r.ok) throw new StoreError(502, `Google Play 校验失败（${r.status}）`, 'store_error');
    return text ? JSON.parse(text) : {};
  }
  const tok = (t) => encodeURIComponent(String(t));
  return {
    subscription: (purchaseToken) => call('GET', `/purchases/subscriptionsv2/tokens/${tok(purchaseToken)}`),
    acknowledgeSubscription: (productId, purchaseToken) => call('POST', `/purchases/subscriptions/${tok(productId)}/tokens/${tok(purchaseToken)}:acknowledge`),
    product: (productId, purchaseToken) => call('GET', `/purchases/products/${tok(productId)}/tokens/${tok(purchaseToken)}`),
    consume: (productId, purchaseToken) => call('POST', `/purchases/products/${tok(productId)}/tokens/${tok(purchaseToken)}:consume`),
  };
}

export const GOOGLE_STATE = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_ON_HOLD: 'expired',
  SUBSCRIPTION_STATE_PAUSED: 'expired',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};
