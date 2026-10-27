export type PlanId = 't1' | 't2';
export type Period = 'month' | 'year';
export type EffectivePlan = 'trial' | 't1' | 't2' | 'owner' | 'expired';
export interface PlanDef { name: string; month: number; year: number; ai: number; push: boolean; export: boolean }
export declare const TRIAL: { days: number; ai: number };
export declare const PLANS: Record<PlanId, PlanDef>;
export declare const PLAN_LABEL: Record<EffectivePlan, string>;
export declare function monthKey(d?: Date): string;
export interface Entitlement {
  plan: EffectivePlan;
  period: Period | null;
  trialUntil: string | null;
  planUntil: string | null;
  features: { edit: boolean; push: boolean; export: boolean };
  ai: { key: string | null; limit: number };
  daysLeft: number | null;
}
export declare function entitlement(profile: { plan?: string | null; period?: string | null; plan_until?: string | null; trial_until?: string | null } | null, opts?: { email?: string; owners?: string[]; now?: Date; plans?: Record<PlanId, PlanDef>; trial?: { days: number; ai: number } }): Entitlement;
export declare function priceOf(plan: string, period: string, plans?: Record<PlanId, PlanDef>): number | null;
export declare const AI_PACK: { qty: number; price: number };
export declare const STORE: {
  apple: Record<'t1.month' | 't1.year' | 't2.month' | 't2.year' | 'ai_pack', string>;
  google: { t1: string; t2: string; basePlan: Record<Period, string>; ai_pack: string };
};
export declare function planOfProduct(store: 'apple' | 'google', productId: string, basePlanId?: string | null): { plan: PlanId; period: Period } | null;
export interface SubRow { id?: string; source?: string; plan: string; period?: string; until: string | null; status: string; auto_renew?: boolean }
export declare function bestSub<T extends SubRow>(subs: T[] | null | undefined, now?: Date): T | null;
