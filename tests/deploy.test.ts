import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore
import { main, parseRef, pagesUrl, DeployError, smtpConfig, ensureReviewAccount } from '../scripts/deploy.mjs';

describe('一键部署脚本', () => {
  it('解析项目 ref 与 GitHub Pages 网址', () => {
    expect(parseRef('https://uszhvzetcwnegugjlcgi.supabase.co')).toBe('uszhvzetcwnegugjlcgi');
    expect(parseRef('uszhvzetcwnegugjlcgi')).toBe('uszhvzetcwnegugjlcgi');
    expect(parseRef('xx')).toBeNull();
    expect(pagesUrl({ GITHUB_REPOSITORY: 'tagmycup-hub/zhangqi' })).toBe('https://tagmycup-hub.github.io/zhangqi/');
    expect(pagesUrl({ GITHUB_REPOSITORY: 'TagMyCup-Hub/tagmycup-hub.github.io' })).toBe('https://tagmycup-hub.github.io/');
  });
  it('缺少密钥时列出要填哪些', async () => {
    await expect(main({ env: {}, log: () => {} })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN[\s\S]*SUPABASE_PROJECT_REF[\s\S]*GEMINI_API_KEY/);
  });
  it('完整流程：建表、登录设置、部署函数、密钥、定时推送、写网站配置（SQL 在真实数据库上可重复运行）', async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
    // 定时推送需要的扩展在 PGlite 里没有：模拟 cron/net
    await pg.exec(`create schema cron; create table cron.job(jobid serial, jobname text); create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job(jobname) values (n) returning jobid $$; create function cron.unschedule(id int) returns bool language sql as $$ delete from cron.job where jobid = id returning true $$;`);
    const root = mkdtempSync(path.join(tmpdir(), 'zq-deploy-'));
    mkdirSync(path.join(root, 'supabase'));
    cpSync('supabase/setup.sql', path.join(root, 'supabase/setup.sql'));
    cpSync('supabase/push-cron.sql', path.join(root, 'supabase/push-cron.sql'));
    const calls: { method: string; path: string; body: any }[] = [];
    const runs: string[][] = [];
    const fetchImpl = async (url: string, init: any) => {
      const p = url.replace('https://api.supabase.com/v1', '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: p, body });
      expect(init.headers.authorization).toBe('Bearer sbp_test');
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (p === '/projects/abcdefghijklmnopqrst') return j({ name: 'zq', status: 'ACTIVE_HEALTHY' });
      if (p.endsWith('/database/query')) {
        await pg.exec(body.query.replace(/create extension[^;]*;/g, ''));
        return j([]);
      }
      if (p.includes('/api-keys')) return j([{ name: 'anon', type: 'legacy', api_key: 'eyJlegacy' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' }]);
      return j({});
    };
    const env = { SUPABASE_ACCESS_TOKEN: 'sbp_test', SUPABASE_PROJECT_REF: 'https://abcdefghijklmnopqrst.supabase.co', GEMINI_API_KEY: 'g', OWNER_EMAILS: 'me@x.com', GITHUB_REPOSITORY: 'tagmycup-hub/zhangqi' };
    const run = async (_c: string, args: string[]) => {
      runs.push(args);
      if (args.includes('--use-api')) throw new Error('old cli');
      return '';
    };
    const out = await main({ env, fetchImpl, run, root, log: () => {} });
    // 再跑一次：全部可重复执行
    await main({ env, fetchImpl, run, root, log: () => {} });
    expect(out.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_xyz', functionName: 'recognize', siteUrl: 'https://tagmycup-hub.github.io/zhangqi/' });
    expect(JSON.parse(readFileSync(path.join(root, 'dist/zq-config.json'), 'utf8'))).toEqual(out.config);
    expect(calls.find((c) => c.path.endsWith('/config/auth'))!.body).toMatchObject({ mailer_autoconfirm: true, site_url: 'https://tagmycup-hub.github.io/zhangqi/' });
    expect(calls.find((c) => c.path.endsWith('/secrets'))!.body).toEqual([{ name: 'GEMINI_API_KEY', value: 'g' }, { name: 'OWNER_EMAILS', value: 'me@x.com' }]);
    expect(runs[0]).toEqual(['functions', 'deploy', 'recognize', '--project-ref', 'abcdefghijklmnopqrst', '--no-verify-jwt', '--use-api']);
    expect(runs[1]).not.toContain('--use-api');
    expect((await pg.query(`select value from zq_kv where key = 'fn_url'`)).rows[0]).toEqual({ value: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/recognize' });
    expect((await pg.query(`select count(*)::int as n from cron.job where jobname = 'zq-daily-push'`)).rows[0]).toEqual({ n: 1 });
  });
  it('令牌权限不够：登录设置这一步跳过并提示手动操作，其余照常完成', async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
    await pg.exec(`create schema cron; create table cron.job(jobid serial, jobname text); create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job(jobname) values (n) returning jobid $$; create function cron.unschedule(id int) returns bool language sql as $$ delete from cron.job where jobid = id returning true $$;`);
    const root = mkdtempSync(path.join(tmpdir(), 'zq-deploy-'));
    mkdirSync(path.join(root, 'supabase'));
    cpSync('supabase/setup.sql', path.join(root, 'supabase/setup.sql'));
    cpSync('supabase/push-cron.sql', path.join(root, 'supabase/push-cron.sql'));
    const fetchImpl = async (url: string, init: any) => {
      const p = url.replace('https://api.supabase.com/v1', '');
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (p.endsWith('/config/auth')) return new Response(JSON.stringify({ message: 'Missing required permission(s): project_admin_write', error: { missing_permissions: ['project_admin_write'] } }), { status: 403 });
      if (p === '/projects/abcdefghijklmnopqrst') return j({ name: 'zq', status: 'ACTIVE_HEALTHY' });
      if (p.endsWith('/database/query')) {
        await pg.exec(JSON.parse(init.body).query.replace(/create extension[^;]*;/g, ''));
        return j([]);
      }
      if (p.includes('/api-keys')) return j([{ name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' }]);
      return j({});
    };
    const logs: string[] = [];
    const out = await main({
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_scoped', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', GEMINI_API_KEY: 'g', GITHUB_REPOSITORY: 'ecoflasky-studio/payment-assistant' },
      fetchImpl,
      run: async () => '',
      root,
      log: (m: string) => logs.push(m),
    });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/关闭 Confirm email[\s\S]*Site URL 填 https:\/\/ecoflasky-studio\.github\.io\/payment-assistant\//);
    expect(logs.join('\n')).toMatch(/部署完成（有 1 处要手动补）/);
    // 其余步骤照常完成
    expect(out.config.publishableKey).toBe('sb_publishable_xyz');
    expect(JSON.parse(readFileSync(path.join(root, 'dist/zq-config.json'), 'utf8')).functionName).toBe('recognize');
  });
  it('免费版没配 SMTP 不能改邮件模板：不改模板、其他登录设置照常，并提示配好 SMTP 后重跑', async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
    await pg.exec(`create schema cron; create table cron.job(jobid serial, jobname text); create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job(jobname) values (n) returning jobid $$; create function cron.unschedule(id int) returns bool language sql as $$ delete from cron.job where jobid = id returning true $$;`);
    const root = mkdtempSync(path.join(tmpdir(), 'zq-deploy-'));
    mkdirSync(path.join(root, 'supabase/email'), { recursive: true });
    cpSync('supabase/setup.sql', path.join(root, 'supabase/setup.sql'));
    cpSync('supabase/push-cron.sql', path.join(root, 'supabase/push-cron.sql'));
    cpSync('supabase/email/code.html', path.join(root, 'supabase/email/code.html'));
    const authBodies: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const p = url.replace('https://api.supabase.com/v1', '');
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (p.endsWith('/config/auth')) {
        const b = JSON.parse(init.body);
        authBodies.push(b);
        if (b.mailer_templates_magic_link_content) return new Response(JSON.stringify({ message: 'Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider.', error: { code: 'entitlement_required', feature: 'auth.email_templates' } }), { status: 400 });
        return j({});
      }
      if (p === '/projects/abcdefghijklmnopqrst') return j({ name: 'zq', status: 'ACTIVE_HEALTHY' });
      if (p.endsWith('/database/query')) {
        await pg.exec(JSON.parse(init.body).query.replace(/create extension[^;]*;/g, ''));
        return j([]);
      }
      if (p.includes('/api-keys')) return j([{ name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' }]);
      return j({});
    };
    const out = await main({ env: { SUPABASE_ACCESS_TOKEN: 't', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', GEMINI_API_KEY: 'g', SITE_URL: 'https://zqzh.com.br/' }, fetchImpl, run: async () => '', root, log: () => {} });
    expect(authBodies).toHaveLength(2);
    expect(authBodies[1]).toMatchObject({ mailer_autoconfirm: true, site_url: 'https://zqzh.com.br/' });
    expect(authBodies[1].mailer_templates_magic_link_content).toBeUndefined();
    expect(out.warnings.join('\n')).toMatch(/SMTP/);
    expect(out.config.siteUrl).toBe('https://zqzh.com.br/');
  });

  it('其他步骤权限不够时直接报错，并说明要换全部权限的令牌', async () => {
    const e = await main({
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_scoped', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', GEMINI_API_KEY: 'g' },
      fetchImpl: async () => new Response(JSON.stringify({ error: { missing_permissions: ['project_admin_read'] } }), { status: 403 }),
      run: async () => '',
      root: '.',
      log: () => {},
    }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/缺少 project_admin_read.*全部权限/);
  });
  it('令牌无效给出中文说明', async () => {
    const env = { SUPABASE_ACCESS_TOKEN: 'bad', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', GEMINI_API_KEY: 'g' };
    const e = await main({ env, fetchImpl: async () => new Response('{}', { status: 401 }), run: async () => '', root: '.', log: () => {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeployError);
    expect((e as Error).message).toMatch(/重新生成/);
  });
  it('Resend 发信：从网站域名推出发件人，密钥格式不对时报错', () => {
    expect(smtpConfig({}, 'https://zqzh.com.br/')).toBeNull();
    expect(smtpConfig({ RESEND_API_KEY: 're_123456789abc' }, 'https://zqzh.com.br/')).toMatchObject({ smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: 're_123456789abc', smtp_admin_email: 'noreply@zqzh.com.br' });
    expect(smtpConfig({ RESEND_API_KEY: 're_123456789abc', MAIL_FROM: '账期助手 <oi@zqzh.com.br>' }, null)).toMatchObject({ smtp_admin_email: 'oi@zqzh.com.br', smtp_sender_name: '账期助手' });
    expect(() => smtpConfig({ RESEND_API_KEY: 'abc' }, 'https://zqzh.com.br/')).toThrow(/re_/);
    expect(() => smtpConfig({ RESEND_API_KEY: 're_123456789abc' }, 'https://x.github.io/app/')).toThrow(/MAIL_FROM/);
  });
  it('审核账号：不存在就新建，已存在就改密码；试用期延长到一年', async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
    await pg.exec(readFileSync('supabase/setup.sql', 'utf8').replace(/create extension[^;]*;/g, ''));
    const sql = async (q: string) => (await pg.query(q)).rows;
    const api = async () => [{ type: 'secret', api_key: 'sb_secret_x' }];
    const hits: { method: string; url: string; headers: any; body: any }[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      hits.push({ method: init.method, url, headers: init.headers, body });
      if (init.method === 'POST') {
        await pg.query(`insert into auth.users(id, email) values ('22222222-2222-4222-8222-222222222222', $1)`, [body.email]);
        return new Response(JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const env = { REVIEW_EMAIL: 'Review@zqzh.com.br', REVIEW_PASSWORD: 'Senha12345' };
    const a = await ensureReviewAccount({ env, api, sql, projectUrl: 'https://p.supabase.co', ref: 'p', fetchImpl });
    expect(a).toMatchObject({ email: 'review@zqzh.com.br', created: true });
    expect(hits[0]).toMatchObject({ method: 'POST', url: 'https://p.supabase.co/auth/v1/admin/users', body: { email: 'review@zqzh.com.br', password: 'Senha12345', email_confirm: true } });
    expect(hits[0].headers.apikey).toBe('sb_secret_x');
    const b = await ensureReviewAccount({ env, api, sql, projectUrl: 'https://p.supabase.co', ref: 'p', fetchImpl });
    expect(b.created).toBe(false);
    expect(hits[1]).toMatchObject({ method: 'PUT', url: 'https://p.supabase.co/auth/v1/admin/users/22222222-2222-4222-8222-222222222222' });
    const days = (await pg.query<{ d: number }>(`select extract(day from trial_until - now())::int as d from zq_profiles`)).rows[0].d;
    expect(days).toBeGreaterThanOrEqual(363);
    await expect(ensureReviewAccount({ env: { REVIEW_EMAIL: 'x@y.z', REVIEW_PASSWORD: '123' }, api, sql, projectUrl: '', ref: 'p', fetchImpl })).rejects.toThrow(/8/);
  });
});
