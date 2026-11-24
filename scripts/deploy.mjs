#!/usr/bin/env node
/**
 * 账期助手 · 一键部署（GitHub Actions 里运行，也可以在本机运行）
 *
 * 做的事（全部可重复执行）：
 *   1. 检查密钥与 Supabase 项目
 *   2. 运行建表脚本 supabase/setup.sql（账号同步、套餐、用量、推送）
 *   3. 登录设置：邮箱 + 密码注册即可登录（不发确认邮件，不需要 SMTP），网站地址
 *   4. 部署识别函数（AI 识别 / 账号 / 订阅 / 推送都在这一个函数里），关闭 Verify JWT
 *   5. 写入函数密钥（GEMINI_API_KEY、MP_ACCESS_TOKEN、OWNER_EMAILS…）
 *   6. 开启每天 09:00（圣保罗）的到期推送
 *   7. 生成网站配置 dist/zq-config.json（Project URL + publishable key + 函数名）
 *
 * 需要的环境变量：SUPABASE_ACCESS_TOKEN、SUPABASE_PROJECT_REF（或 Project URL）、GEMINI_API_KEY
 * 可选：MP_ACCESS_TOKEN、MP_WEBHOOK_SECRET、OWNER_EMAILS、SITE_URL、FUNCTION_NAME
 *       RESEND_API_KEY（+ MAIL_FROM）：用 Resend 发验证码邮件（自定义 SMTP）
 *       REVIEW_EMAIL + REVIEW_PASSWORD：建立 / 更新商店审核用的测试账号（试用期延长到一年）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.supabase.com/v1';

export class DeployError extends Error {}

export function parseRef(v) {
  const s = String(v || '').trim();
  const m = s.match(/^https?:\/\/([a-z0-9]{10,40})\.supabase\.co/i);
  if (m) return m[1];
  if (/^[a-z0-9]{10,40}$/i.test(s)) return s;
  return null;
}

/** GitHub Pages 网址：<owner>.github.io/<repo>/（仓库名本身是 <owner>.github.io 时为根目录） */
export function pagesUrl(env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/?$/, '/');
  const repo = env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

export async function main({ env = process.env, fetchImpl = fetch, run, root, log = console.log } = {}) {
  root = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  run = run ?? (async (cmd, args, extraEnv) => (await promisify(execFile)(cmd, args, { cwd: root, env: { ...process.env, ...extraEnv }, maxBuffer: 20 * 1024 * 1024 })).stdout);
  const step = (n, t) => log(`\n▶ ${n}. ${t}`);
  const ok = (t) => log(`  ✓ ${t}`);

  step(1, '检查密钥');
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref = parseRef(env.SUPABASE_PROJECT_REF);
  const missing = [];
  if (!token) missing.push('SUPABASE_ACCESS_TOKEN（supabase.com/dashboard/account/tokens 生成）');
  if (!ref) missing.push('SUPABASE_PROJECT_REF（Project URL 里 https:// 和 .supabase.co 之间那段，或直接填 Project URL）');
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY（aistudio.google.com/apikey 生成）');
  if (missing.length) throw new DeployError(`缺少仓库密钥（Settings → Secrets and variables → Actions → New repository secret）：\n  - ${missing.join('\n  - ')}`);
  const fn = env.FUNCTION_NAME || 'recognize';
  const projectUrl = `https://${ref}.supabase.co`;
  const fnUrl = `${projectUrl}/functions/v1/${fn}`;
  const site = pagesUrl(env);

  const warnings = [];
  const api = async (method, p, body) => {
    const r = await fetchImpl(`${API}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) {
      if (r.status === 401) throw new DeployError('SUPABASE_ACCESS_TOKEN 无效或已过期：请到 supabase.com/dashboard/account/tokens 重新生成');
      if (r.status === 404 && p === `/projects/${ref}`) throw new DeployError(`找不到项目 ${ref}：请检查 SUPABASE_PROJECT_REF`);
      if (r.status === 403) {
        let perms = [];
        try {
          perms = JSON.parse(text)?.error?.missing_permissions ?? [];
        } catch {}
        const e = new DeployError(`访问令牌权限不够${perms.length ? `（缺少 ${perms.join('、')}）` : ''}：请到 supabase.com/dashboard/account/tokens 重新生成一个「全部权限 / Full access」的令牌，更新仓库密钥 SUPABASE_ACCESS_TOKEN 后重新运行`);
        e.permission = true;
        throw e;
      }
      throw new DeployError(`Supabase 接口 ${method} ${p} 失败（${r.status}）：${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  };
  const sql = (query) => api('POST', `/projects/${ref}/database/query`, { query });

  const project = await api('GET', `/projects/${ref}`);
  if (project?.status && !/ACTIVE/i.test(project.status)) throw new DeployError(`项目 ${ref} 当前状态是 ${project.status}（可能已暂停）：请先在 Supabase 控制台恢复项目`);
  ok(`项目 ${project?.name ?? ref}（${projectUrl}）`);

  step(2, '建表（可重复运行，不会删除数据）');
  await sql(await readFile(path.join(root, 'supabase/setup.sql'), 'utf8'));
  ok('数据库已就绪');

  step(3, '登录设置');
  // 验证码邮件：中葡英三语一封（Supabase 一个项目只能有一套模板）
  const codeMail = await readFile(path.join(root, 'supabase/email/code.html'), 'utf8').catch(() => null);
  const subject = '账期助手验证码 · Código · Code: {{ .Token }}';
  const auth = { mailer_autoconfirm: true, external_email_enabled: true, password_min_length: 8, mailer_otp_exp: 600 };
  // 用 Resend 发信：配好后验证码邮件从自己的域名发出，也才能改成三语模板
  const smtp = smtpConfig(env, site);
  if (smtp) Object.assign(auth, smtp);
  if (codeMail) Object.assign(auth, { mailer_subjects_magic_link: subject, mailer_templates_magic_link_content: codeMail, mailer_subjects_confirmation: subject, mailer_templates_confirmation_content: codeMail });
  if (site) Object.assign(auth, { site_url: site, uri_allow_list: site });
  const MAIL_KEYS = ['mailer_subjects_magic_link', 'mailer_templates_magic_link_content', 'mailer_subjects_confirmation', 'mailer_templates_confirmation_content'];
  let mailOk = !!codeMail;
  try {
    try {
      await api('PATCH', `/projects/${ref}/config/auth`, auth);
    } catch (e) {
      // 免费版 + Supabase 自带邮件时不允许改邮件模板：先不改模板，其他设置照常；配好自己的 SMTP 后再运行就会生效
      if (!codeMail || !/entitlement_required|email_templates|custom SMTP/i.test(e.message)) throw e;
      for (const k of MAIL_KEYS) delete auth[k];
      await api('PATCH', `/projects/${ref}/config/auth`, auth);
      mailOk = false;
      const note = '验证码邮件模板没改：Supabase 免费版要先配好自己的 SMTP（见《上架指南》5b，推荐 Resend），配好后重新运行「一键部署」就会换成中葡英三语模板。';
      log(`  ! ${note}`);
      warnings.push(note);
    }
    ok(`邮箱 + 密码注册即登录（不发确认邮件）${smtp ? `；验证码邮件由 Resend 发送（发件人 ${smtp.smtp_admin_email}）` : ''}${mailOk ? '；验证码邮件改为中葡英三语' : ''}${site ? `；网站地址 ${site}` : ''}`);
    if (smtp) {
      // 自定义 SMTP 默认每小时只能发 30 封，调高一些（失败不影响其他设置）
      try {
        await api('PATCH', `/projects/${ref}/config/auth`, { rate_limit_email_sent: 200 });
      } catch {}
    }
  } catch (e) {
    // 这一步只是改两个开关，令牌权限不够时可以在控制台手动做，不中断整个部署
    if (!e.permission) throw e;
    const manual = [
      '登录设置没改成（令牌权限不够），请在 Supabase 控制台手动设置一次：',
      '  Authentication → Sign In / Providers → Email：关闭 Confirm email，保存',
      site ? `  Authentication → URL Configuration → Site URL 填 ${site}` : null,
      '  （或者换成「全部权限」的访问令牌后重新运行，就会自动设置）',
    ].filter(Boolean).join('\n');
    log(`  ! ${manual.replace(/\n/g, '\n  ')}`);
    warnings.push(manual);
  }

  if (env.REVIEW_EMAIL || env.REVIEW_PASSWORD) {
    step('3b', '商店审核测试账号');
    try {
      const r = await ensureReviewAccount({ env, api, sql, projectUrl, ref, fetchImpl });
      ok(`${r.email}（${r.created ? '新建' : '已更新密码'}，试用期到 ${r.until}）`);
    } catch (e) {
      const note = `审核测试账号没建好：${e.message}。可以先在网站上用这个邮箱注册，再重新运行一次部署。`;
      log(`  ! ${note}`);
      warnings.push(note);
    }
  }

  step(4, `部署识别函数「${fn}」`);
  const base = ['functions', 'deploy', fn, '--project-ref', ref, '--no-verify-jwt'];
  try {
    await run('supabase', [...base, '--use-api'], { SUPABASE_ACCESS_TOKEN: token });
  } catch {
    await run('supabase', base, { SUPABASE_ACCESS_TOKEN: token });
  }
  ok(fnUrl);

  step(5, '写入函数密钥');
  const secrets = Object.entries({
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN,
    MP_WEBHOOK_SECRET: env.MP_WEBHOOK_SECRET,
    OWNER_EMAILS: env.OWNER_EMAILS,
    // App 内购校验（见 docs/上架指南.md）
    APPLE_BUNDLE_ID: env.APPLE_BUNDLE_ID || (env.APPLE_ISSUER_ID ? env.APP_ID || 'com.ecoflasky.zhangqi' : ''),
    APPLE_ISSUER_ID: env.APPLE_ISSUER_ID,
    APPLE_KEY_ID: env.APPLE_IAP_KEY_ID,
    APPLE_PRIVATE_KEY: env.APPLE_IAP_PRIVATE_KEY,
    GOOGLE_PACKAGE_NAME: env.GOOGLE_PACKAGE_NAME || (env.GOOGLE_SERVICE_ACCOUNT ? env.APP_ID || 'com.ecoflasky.zhangqi' : ''),
    GOOGLE_SERVICE_ACCOUNT: env.GOOGLE_SERVICE_ACCOUNT,
    GOOGLE_RTDN_TOKEN: env.GOOGLE_RTDN_TOKEN,
  })
    .filter(([, v]) => v)
    .map(([name, value]) => ({ name, value }));
  await api('POST', `/projects/${ref}/secrets`, secrets);
  ok(secrets.map((s) => s.name).join('、'));
  if (!env.MP_ACCESS_TOKEN) log('  ! 没有 MP_ACCESS_TOKEN：订阅收款未开放，用户试用结束后只能查看（之后补上密钥再运行一次即可）');

  step(6, '每天 09:00（圣保罗）到期推送');
  await sql(`insert into public.zq_kv(key, value) values ('fn_url', '${fnUrl.replace(/'/g, "''")}') on conflict (key) do update set value = excluded.value, updated_at = now();`);
  try {
    await sql(await readFile(path.join(root, 'supabase/push-cron.sql'), 'utf8'));
    ok('定时任务已设置（12:00 UTC）');
  } catch (e) {
    log(`  ! 定时推送没设置成功（不影响其他功能）：${e.message}`);
  }

  step(7, '生成网站配置 zq-config.json');
  const keys = (await api('GET', `/projects/${ref}/api-keys?reveal=false`)) ?? [];
  const pub = keys.find((k) => k.type === 'publishable') ?? keys.find((k) => k.name === 'anon' || k.type === 'legacy');
  if (!pub?.api_key) throw new DeployError('没找到 publishable key：请在 Supabase → Project Settings → API Keys 创建一个 publishable key 后重试');
  const cfg = { supabaseUrl: projectUrl, publishableKey: pub.api_key, functionName: fn, ...(site ? { siteUrl: site } : {}) };
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/zq-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  ok('dist/zq-config.json');

  log(warnings.length ? `\n✅ 部署完成（有 ${warnings.length} 处要手动补）` : '\n✅ 部署完成');
  warnings.forEach((w) => log(`\n⚠ ${w}`));
  if (site) log(`   网站：${site}`);
  log(`   Mercado Pago 通知网址（在 Mercado Pago 开发者后台 → Webhooks 填写，事件选「Planos e assinaturas」和「Pagamentos」）：\n   ${fnUrl}/billing/webhook`);
  if (env.APPLE_ISSUER_ID) log(`   App Store 服务器通知网址（App Store Connect → App 信息 → App Store 服务器通知，版本 2，正式和沙盒都填）：\n   ${fnUrl}/iap/apple`);
  if (env.GOOGLE_SERVICE_ACCOUNT) log(`   Google Play 实时通知（Pub/Sub 推送订阅的端点网址）：\n   ${fnUrl}/iap/google?token=${env.GOOGLE_RTDN_TOKEN ? '<GOOGLE_RTDN_TOKEN>' : '（先设置 GOOGLE_RTDN_TOKEN）'}`);
  return { ref, fnUrl, site, config: cfg, warnings };
}

/** Resend 的 SMTP 设置（没有 RESEND_API_KEY 时返回 null） */
export function smtpConfig(env, site) {
  const key = (env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(key)) throw new DeployError('RESEND_API_KEY 格式不对：应该以 re_ 开头（Resend → API Keys 里复制）');
  const host = site ? new URL(site).hostname.replace(/^www\./, '') : null;
  const raw = (env.MAIL_FROM || (host && !/github\.io$/.test(host) ? `noreply@${host}` : '')).trim();
  // 支持「名字 <邮箱>」或只写邮箱
  const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
  const email = (m ? m[2] : raw).trim();
  const name = (m ? m[1] : '').trim().replace(/^"|"$/g, '') || 'ZhangQi 账期助手';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DeployError('用 Resend 发信需要发件邮箱：请加仓库变量或密钥 MAIL_FROM，例如 noreply@zqzh.com.br（域名要先在 Resend 验证）');
  return { smtp_admin_email: email, smtp_sender_name: name, smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: key };
}

/** 建立（或更新密码）审核账号，并把试用期延长到一年后 */
export async function ensureReviewAccount({ env, api, sql, projectUrl, ref, fetchImpl = fetch }) {
  const email = String(env.REVIEW_EMAIL || '').trim().toLowerCase();
  const password = String(env.REVIEW_PASSWORD || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DeployError('REVIEW_EMAIL 不是有效邮箱');
  if (password.length < 8) throw new DeployError('REVIEW_PASSWORD 至少 8 位');
  const keys = (await api('GET', `/projects/${ref}/api-keys?reveal=true`)) ?? [];
  const secret = keys.find((k) => k.type === 'secret')?.api_key ?? keys.find((k) => k.name === 'service_role')?.api_key;
  if (!secret) throw new DeployError('没找到 secret key（Project Settings → API Keys）');
  const headers = { apikey: secret, 'content-type': 'application/json', ...(secret.startsWith('eyJ') ? { authorization: `Bearer ${secret}` } : {}) };
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const found = await sql(`select id from auth.users where lower(email) = ${q(email)} limit 1;`);
  let id = Array.isArray(found) && found[0]?.id;
  let created = false;
  if (!id) {
    const r = await fetchImpl(`${projectUrl}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email, password, email_confirm: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DeployError(`新建失败（${r.status}）：${j.msg || j.message || j.error_description || ''}`);
    id = j.id ?? j.user?.id;
    created = true;
  } else {
    const r = await fetchImpl(`${projectUrl}/auth/v1/admin/users/${id}`, { method: 'PUT', headers, body: JSON.stringify({ password, email_confirm: true }) });
    if (!r.ok) throw new DeployError(`更新密码失败（${r.status}）`);
  }
  if (!id) throw new DeployError('没拿到用户 ID');
  const rows = await sql(
    `insert into public.zq_profiles(user_id, email, trial_until) values (${q(id)}, ${q(email)}, now() + interval '365 days')
       on conflict (user_id) do update set trial_until = greatest(public.zq_profiles.trial_until, now() + interval '365 days'), updated_at = now()
     returning to_char(trial_until at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') as until;`,
  );
  return { email, created, until: (Array.isArray(rows) && rows[0]?.until) || '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n❌ ${e instanceof DeployError ? e.message : e?.stack ?? e}`);
    process.exit(1);
  });
}
