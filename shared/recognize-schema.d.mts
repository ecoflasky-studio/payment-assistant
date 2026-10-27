export interface ArithmeticIssue {
  row: number | null;
  kind: 'row' | 'total';
  calc: number;
  printed: number;
}
export declare const RECOGNIZE_SCHEMA: { type: 'OBJECT'; properties: Record<string, any>; required: string[]; propertyOrdering: string[] };
export declare function arithmeticIssues(result: any): ArithmeticIssue[];
export declare function verifyPrompt(basePrompt: string, result: any, issues: ArithmeticIssue[]): string;
export declare function acceptVerified(first: any, second: any): boolean;
