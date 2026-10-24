// 由 npm run build:worker 生成
export declare function serve(req: Request, env: Record<string, string | undefined>): Promise<Response>;
export declare function supabaseEnv(all: Record<string, string | undefined>): Record<string, string | undefined>;
export declare function projectKeys(get: (k: string) => string): string[];
