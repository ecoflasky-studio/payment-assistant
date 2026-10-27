/**
 * 识别结果的结构化输出 Schema（Gemini responseSchema，OpenAPI 子集）与「算术复核」。
 * 前端与服务端共用；模型按 Schema 输出，字段不会放错位置、也不会多出说明文字。
 */

const S = (description, extra = {}) => ({ type: 'STRING', nullable: true, description, ...extra });
const I = (description) => ({ type: 'INTEGER', nullable: true, description });
const N = (description) => ({ type: 'NUMBER', nullable: true, description });
const C = { type: 'NUMBER', description: '0–1：每个字都清楚 ≥0.95；一个字符拿不准 0.6–0.8；多处拿不准 ≤0.5' };
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'OBJECT', properties, required, propertyOrdering: Object.keys(properties), ...extra });
const dateF = (what) => obj({ raw: S(`${what}原文照抄`), iso: S('YYYY-MM-DD；年份写全且日期真实存在时才填，否则 null'), confidence: C });

export const RECOGNIZE_SCHEMA = obj(
  {
    docType: { type: 'STRING', enum: ['order', 'boleto', 'utility', 'tax', 'payslip', 'statement', 'receipt'], description: '单据类型' },
    merchant: obj({ value: S('收款方名称（不是付款人）'), confidence: C, candidates: { type: 'ARRAY', items: { type: 'STRING' }, description: '其他可能的收款方写法' } }),
    orderNumber: obj({ value: S('订单号/单号，保留前导零'), confidence: C }),
    billDate: dateF('开单日期'),
    dueDate: dateF('到期日 Vencimento'),
    amountDue: obj({ raw: S('应付金额原文'), cents: I('应付金额，整数分'), confidence: C }),
    paymentLine: S('47/48 位数字线逐位照抄；看不清为 null'),
    pixCode: S('PIX Copia e Cola 原文'),
    referenceMonth: S('账单所属月份原文'),
    categoryHint: S('缴费类别', { enum: ['water', 'electricity', 'gas', 'internet', 'phone', 'rent', 'condo', 'tax', 'payroll', 'accounting', 'logistics', 'platform', 'loan', 'subscription', 'other'] }),
    items: {
      type: 'ARRAY',
      description: '逐行明细，按单据从上到下',
      items: obj(
        {
          row: { type: 'INTEGER', description: '行号，从 1 开始' },
          quantity: N('总件数'),
          boxes: N('箱数（「箱数×每箱件数×单价」写法时）'),
          perBox: N('每箱件数'),
          description: S('型号/描述原样照抄'),
          unitPriceRaw: S('单价原文照抄'),
          unitPriceCents: I('单价，整数分'),
          printedSubtotalRaw: S('图片上写的本行小计原文'),
          printedSubtotalCents: I('图片上写的本行小计，整数分'),
          confidence: C,
          needsReview: { type: 'BOOLEAN', description: '确有拿不准的字符时为 true' },
          bbox: { type: 'ARRAY', nullable: true, items: { type: 'NUMBER' }, description: '[x, y, w, h] 归一化 0–1' },
        },
        ['row', 'quantity', 'description', 'unitPriceRaw', 'unitPriceCents', 'printedSubtotalRaw', 'printedSubtotalCents', 'confidence', 'needsReview'],
      ),
    },
    printedTotalRaw: S('图片上的总额原文'),
    printedTotalCents: I('图片上的总额，整数分'),
    statement: obj(
      {
        entries: { type: 'ARRAY', items: obj({ date: S('YYYY-MM-DD'), dateRaw: S('日期原文'), orderNumber: S('单号'), cents: I('金额，整数分'), raw: S('金额原文'), paid: { type: 'BOOLEAN', nullable: true } }) },
        payments: { type: 'ARRAY', items: obj({ date: S('YYYY-MM-DD'), cents: I('金额，整数分'), note: S('备注') }) },
        balanceCents: I('结欠，整数分'),
      },
      ['entries', 'payments', 'balanceCents'],
      { nullable: true, description: '只有 docType 为 statement 时填写，其他为 null' },
    ),
    unparsedLines: { type: 'ARRAY', items: { type: 'STRING' }, description: '含数字但无法拆成明细的行原文' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' }, description: '算术不符、涂改、按小计辨认等说明' },
  },
  ['docType', 'merchant', 'orderNumber', 'billDate', 'dueDate', 'amountDue', 'items', 'printedTotalRaw', 'printedTotalCents', 'unparsedLines', 'warnings'],
);

const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/**
 * 找出算术对不上的地方（只看模型自己读出的数字）：
 *  - 某行 数量 × 单价 ≠ 图片小计
 *  - 每行都有小计时，小计之和 ≠ 图片总额
 */
export function arithmeticIssues(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const issues = [];
  let sum = 0;
  let complete = items.length > 0;
  for (const [i, it] of items.entries()) {
    const q = typeof it?.quantity === 'number' ? it.quantity : null;
    const u = int(it?.unitPriceCents);
    const s = int(it?.printedSubtotalCents);
    const calc = q !== null && u !== null ? Math.round(q * u) : null;
    if (calc !== null && s !== null && calc !== s) issues.push({ row: it?.row ?? i + 1, kind: 'row', calc, printed: s });
    const lineTotal = s ?? calc;
    if (lineTotal === null) complete = false;
    else sum += lineTotal;
  }
  const total = int(result?.printedTotalCents);
  if (complete && total !== null && sum !== total) issues.push({ row: null, kind: 'total', calc: sum, printed: total });
  return issues;
}

const brl = (c) => (c / 100).toFixed(2).replace('.', ',');

/** 第二遍「复核」提示词：只重看对不上的行 */
export function verifyPrompt(basePrompt, result, issues) {
  const lines = issues.map((x) => (x.kind === 'row' ? `- 第 ${x.row} 行：数量×单价 = ${brl(x.calc)}，但读到的小计是 ${brl(x.printed)}` : `- 明细合计 ${brl(x.calc)}，但读到的总额是 ${brl(x.printed)}`));
  return `${basePrompt}

【复核】你刚才对这张图片的识别结果如下：
${JSON.stringify({ items: result.items, printedTotalRaw: result.printedTotalRaw ?? null, printedTotalCents: result.printedTotalCents ?? null })}

其中这些地方算术对不上：
${lines.join('\n')}

请重新仔细查看原图上这些行的数量、单价、小计和总额的每一个字符（特别注意 1/7、4/9、5/6、0/6、3/8 等手写混淆），然后按同一 Schema 输出完整 JSON。
规则：清楚可读的数字不得为了凑数而修改；确实读错的改正并在 warnings 写「复核第 N 行：X 改为 Y」；如果原单据本身就算错了，保持读数，在 warnings 写「原单据第 N 行算术不符」。`;
}

/** 复核结果可采用：仍是有效对象、明细行数没有大幅减少、对不上的地方变少了 */
export function acceptVerified(first, second) {
  if (!second || typeof second !== 'object' || !Array.isArray(second.items)) return false;
  const n1 = Array.isArray(first?.items) ? first.items.length : 0;
  if (second.items.length < Math.ceil(n1 * 0.8)) return false;
  return arithmeticIssues(second).length < arithmeticIssues(first).length;
}
