// 打包识别服务为单文件：
//  - Cloudflare Worker（worker/dist/zhangqi-worker.js，可直接粘贴到 Cloudflare 控制台）
//  - Supabase Edge Function（supabase/functions/recognize/index.ts，可直接粘贴到 Supabase 函数编辑器）
import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
const common = { bundle: true, format: 'esm', target: 'es2022', loader: { '.txt': 'text' }, charset: 'utf8', logLevel: 'info' };
await build({
  ...common,
  entryPoints: ['worker/entry.mjs'],
  outfile: 'worker/dist/zhangqi-worker.js',
  banner: { js: '// 账期助手识别服务 · Cloudflare Worker（由 npm run build:worker 生成，请勿手改）' },
});
await build({
  ...common,
  entryPoints: ['supabase/entry.mjs'],
  outfile: 'supabase/functions/recognize/index.ts',
  banner: { js: '// @ts-nocheck\n// 账期助手识别服务 · Supabase Edge Function（由 npm run build:worker 生成，请勿手改）\n// 需要的 Secret：GEMINI_API_KEY（或 ANTHROPIC_API_KEY）。函数设置里关闭 Verify JWT。' },
});

// 类型声明：生成物不进版本库，所以每次打包时一并生成，保证全新克隆后 tsc 也能通过
await mkdir('worker/dist', { recursive: true });
await writeFile(
  'worker/dist/zhangqi-worker.d.ts',
  '// 由 npm run build:worker 生成\ndeclare const worker: { fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> };\nexport default worker;\n',
);
await writeFile(
  'supabase/functions/recognize/index.d.ts',
  `// 由 npm run build:worker 生成
export declare function serve(req: Request, env: Record<string, string | undefined>): Promise<Response>;
export declare function supabaseEnv(all: Record<string, string | undefined>): Record<string, string | undefined>;
export declare function projectKeys(get: (k: string) => string): string[];
`,
);
