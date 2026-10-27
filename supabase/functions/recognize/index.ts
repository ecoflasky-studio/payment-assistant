// @ts-nocheck
// 账期助手识别服务 · Supabase Edge Function（由 npm run build:worker 生成，请勿手改）
// 需要的 Secret：GEMINI_API_KEY（或 ANTHROPIC_API_KEY）。函数设置里关闭 Verify JWT。

// shared/recognize-prompt.txt
var recognize_prompt_default = '你是一名严谨的票据录入员。图片是巴西一家小公司收到的一张单据，可能是以下任意一种：\n- order：商家的手写或打印订单（Pedido、收据，可能含中文、葡萄牙语、数字和字母型号，蓝色表格线、阴影、透视变形）\n- boleto：银行付款单（Boleto / Ficha de Compensação，有银行代码、47 位数字线、条码、Vencimento、Valor do Documento）\n- utility：水、电、燃气、网络、电话账单（如 Sabesp、Enel、Comgás、Vivo），通常有"Total a pagar""Vencimento"、二维码或 48 位数字线\n- tax：税费或政府缴费单（DAS、DARF、GPS、FGTS Digital/GFD、IPTU 等）\n- payslip：工资单（Recibo de Pagamento de Salário）\n- statement：对账单 / 欠款明细表（一张表里有多笔订单和付款记录，例如供应商发来的 Excel 截图）\n- receipt：其他收据或单据\n\n判断 docType：印有 47/48 位数字线或条码 → boleto / utility / tax（按收款方判断）；表格里有多笔订单号和付款记录 → statement；有逐行「数量、型号、单价」→ order；只有一个金额的收条 → receipt。\n\n任务：逐字读取单据，只输出一个符合下列 Schema 的 JSON 对象，不要输出任何其他文字。\n\n{\n  "docType": "order"|"boleto"|"utility"|"tax"|"payslip"|"statement"|"receipt",\n  "merchant": {"value": string|null, "confidence": 0..1, "candidates": [string]},\n  "orderNumber": {"value": string|null, "confidence": 0..1},\n  "billDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "dueDate": {"raw": string|null, "iso": "YYYY-MM-DD"|null, "confidence": 0..1},\n  "amountDue": {"raw": string|null, "cents": integer|null, "confidence": 0..1},\n  "paymentLine": string|null,\n  "pixCode": string|null,\n  "referenceMonth": string|null,\n  "categoryHint": "water"|"electricity"|"gas"|"internet"|"phone"|"rent"|"condo"|"tax"|"payroll"|"accounting"|"logistics"|"platform"|"loan"|"subscription"|"other"|null,\n  "items": [\n    {"row": 1, "quantity": number|null, "boxes": number|null, "perBox": number|null,\n     "description": string|null,\n     "unitPriceRaw": string|null, "unitPriceCents": integer|null,\n     "printedSubtotalRaw": string|null, "printedSubtotalCents": integer|null,\n     "confidence": 0..1, "needsReview": boolean,\n     "bbox": [x, y, w, h] | null}\n  ],\n  "printedTotalRaw": string|null,\n  "printedTotalCents": integer|null,\n  "statement": {\n    "entries": [{"date": "YYYY-MM-DD"|null, "dateRaw": string|null, "orderNumber": string|null, "cents": integer|null, "raw": string|null, "paid": boolean|null}],\n    "payments": [{"date": "YYYY-MM-DD"|null, "cents": integer|null, "note": string|null}],\n    "balanceCents": integer|null\n  } | null,\n  "unparsedLines": [string],\n  "warnings": [string]\n}\n\n字段说明：\n- merchant：收款方。订单写商家名；boleto 写 Beneficiário（受益人/收款公司）；水电账单写公司名（如 "Enel"）；税费写税种（如 "FGTS"、"DAS"）；工资单写员工姓名；对账单写对方名称或表头上的客户编号（如 "KH-3913"）。不要写付款人（Pagador / 本公司）。\n- dueDate：Vencimento / "Pagar até"。工资单没有到期日时为 null。\n- amountDue：本单应付金额。boleto 取 "Valor do Documento"；水电取 "Total a pagar"；税费取 "Valor a recolher / Total"；工资单取 "Líquido a receber"；订单取总额。\n- paymentLine：如果单据上印有数字线（linha digitável，47 或 48 位，常见格式如 "34191.09008 04545.379275 90742.810006 9 16010000314822"），逐位照抄；没有或看不清就 null。绝不编造或补全任何一位。\n- pixCode：如果印有 "PIX Copia e Cola" 文字，原样照抄；二维码图片本身不要尝试解码，填 null。\n- referenceMonth：账单所属月份原文（如 "SET/2026"、"Setembro/2026"、"OUTUBRO 2026"）。\n- items：订单逐行明细；boleto / 水电单上的分项（如 "ALUGUEL 1.700,00"、"CONDOMINIO 1.448,22"）每项一行，quantity 填 1，金额写进 unitPrice 和 printedSubtotal。工资单、只有一个总额的单据 items 可为空数组。\n- 手写订单常见写法「箱数 × 每箱件数 × 单价 = 小计」（例如 "2 × 50 × 19 = 1900"）：boxes 填 2、perBox 填 50、quantity 填总件数 100、unitPrice 填 19。只有「数量 × 单价」时 boxes、perBox 为 null。\n- statement：只有 docType 为 statement 时填写。每笔订单/欠款一条 entry；paid 根据表格里的已付标记（颜色、对勾、对应付款）判断，看不出来就 null；payments 是付款记录表里的每一行；balanceCents 是"结欠/Saldo devedor"。其他类型填 null。\n\n硬性规则：\n1. 逐字读取并保留原文。*Raw 字段照抄图片上的写法（例如 "8"、"15,00"、"1.234,56"）。\n2. 看不清就返回 null，并把 needsReview 设为 true，confidence 如实降低。绝不猜测。\n3. 型号/描述按图片原样保留大小写、连字符、空格、中文和数字（如 "FN-A78"、"CA31-3"、"800ml 黑"），不得根据常识补全或"纠正"。\n4. 金额是巴西雷亚尔：逗号是小数点，点是千位分隔（Excel 截图里若明显用点做小数点、逗号做千位，如 "2,808.00"，按截图的写法换算并在 warnings 说明）。*Cents 为整数分（"8" → 800，"1.234,56" → 123456）。无法确定格式时 *Cents 返回 null 并在 warnings 说明。\n5. 不得为了让小计或总额相等而修改任何识别到的数字；算术不一致、总额被涂改或有两个不同的总额时照实输出，并在 warnings 里说明。\n6. 订单号、单号保留前导零，作为字符串输出。\n7. 日期：raw 照抄；只有年份写全（4 位）且日期真实存在时才填 iso，否则 iso 为 null。\n8. 任何包含数字但你无法可靠拆成明细的行，原样放入 unparsedLines，不要丢弃。\n9. bbox 是该明细行在图片中的归一化位置（0–1，左上为原点）；无法确定则为 null。\n10. 只描述这张图片里真实存在的内容；表头、签名、旁边纸张上的内容不要当作明细。\n\n手写订单读法要点：\nA. 先通读整张单据，弄清每列含义（数量 / 箱数×每箱 / 型号 / 单价 / 小计）和每一行的对应关系，再逐行读；一行写不下折到下一行的，合并成一行。\nB. 手写数字常见混淆：1/7、4/9、5/6、0/6、3/8、2/7、S/5、B/8、O/0、I/1、Z/2。一个字形本身有两种合理读法时，可以用同一行「数量×单价=小计」的关系选择读法，但该行 confidence 不得高于 0.8，并在 warnings 写明「第 N 行按小计辨认 X」；清楚可读的数字绝不能为了凑数而改。\nC. 「〃」「"」「同上」「do」表示与上一行相同：展开写成上一行的完整内容，并在 warnings 注明。\nD. 被划掉的行或数字不要读；同一位置改写过的，读最后写上的那个。\nE. 中文数字（一、二、两、十、廿、百）换成阿拉伯数字；「件、个、pç、pc、un」是件数，「箱、cx、caixa」是箱数（填 boxes）；「打、dz、dúzia」照单据写的数量填写，description 末尾保留「(dz)」，不要自行换算。\nF. 型号里的字母 O 与数字 0、字母 I 与数字 1：按同一张单据其他行同系列型号的写法统一（例如其他行都是 "FN-A78"，就不要读成 "FN-A7B"）。\nG. 底部总额常写成 Total / TOTAL / 合计 / 总计 / 共；有分页小计和总计时取最后的总计，并在 warnings 说明。\nH. 商家名通常在抬头、印章或名片位置；手写单据上没有商家名时 merchant 为 null，不要从别处推断。\nI. confidence 要有区分度：每个字都清楚 ≥ 0.95；有一个字符拿不准 0.6–0.8；多处拿不准 ≤ 0.5。needsReview 只在确有拿不准的字符时为 true。\n';

// shared/hints.mjs
var HINTS_MAX = 6e3;
function withHints(prompt, hints) {
  const h = String(hints ?? "").trim().slice(0, HINTS_MAX);
  if (!h) return prompt;
  return prompt + "\n\n【参考资料】以下是这位用户以往记录的商家与型号，只用来帮助辨认模糊的手写字：图片上没有的内容绝不能因为参考资料而写出；看得清的字以图片为准；某处字形本身模糊、而按常用型号/商家名读正好说得通时，可以这样读，但该字段 confidence 不得高于 0.8，并在 warnings 写明「按常用型号辨认」。\n" + h;
}

// shared/recognize-schema.mjs
var S = (description, extra = {}) => ({ type: "STRING", nullable: true, description, ...extra });
var I = (description) => ({ type: "INTEGER", nullable: true, description });
var N = (description) => ({ type: "NUMBER", nullable: true, description });
var C = { type: "NUMBER", description: "0–1：每个字都清楚 ≥0.95；一个字符拿不准 0.6–0.8；多处拿不准 ≤0.5" };
var obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: "OBJECT", properties, required, propertyOrdering: Object.keys(properties), ...extra });
var dateF = (what) => obj({ raw: S(`${what}原文照抄`), iso: S("YYYY-MM-DD；年份写全且日期真实存在时才填，否则 null"), confidence: C });
var RECOGNIZE_SCHEMA = obj(
  {
    docType: { type: "STRING", enum: ["order", "boleto", "utility", "tax", "payslip", "statement", "receipt"], description: "单据类型" },
    merchant: obj({ value: S("收款方名称（不是付款人）"), confidence: C, candidates: { type: "ARRAY", items: { type: "STRING" }, description: "其他可能的收款方写法" } }),
    orderNumber: obj({ value: S("订单号/单号，保留前导零"), confidence: C }),
    billDate: dateF("开单日期"),
    dueDate: dateF("到期日 Vencimento"),
    amountDue: obj({ raw: S("应付金额原文"), cents: I("应付金额，整数分"), confidence: C }),
    paymentLine: S("47/48 位数字线逐位照抄；看不清为 null"),
    pixCode: S("PIX Copia e Cola 原文"),
    referenceMonth: S("账单所属月份原文"),
    categoryHint: S("缴费类别", { enum: ["water", "electricity", "gas", "internet", "phone", "rent", "condo", "tax", "payroll", "accounting", "logistics", "platform", "loan", "subscription", "other"] }),
    items: {
      type: "ARRAY",
      description: "逐行明细，按单据从上到下",
      items: obj(
        {
          row: { type: "INTEGER", description: "行号，从 1 开始" },
          quantity: N("总件数"),
          boxes: N("箱数（「箱数×每箱件数×单价」写法时）"),
          perBox: N("每箱件数"),
          description: S("型号/描述原样照抄"),
          unitPriceRaw: S("单价原文照抄"),
          unitPriceCents: I("单价，整数分"),
          printedSubtotalRaw: S("图片上写的本行小计原文"),
          printedSubtotalCents: I("图片上写的本行小计，整数分"),
          confidence: C,
          needsReview: { type: "BOOLEAN", description: "确有拿不准的字符时为 true" },
          bbox: { type: "ARRAY", nullable: true, items: { type: "NUMBER" }, description: "[x, y, w, h] 归一化 0–1" }
        },
        ["row", "quantity", "description", "unitPriceRaw", "unitPriceCents", "printedSubtotalRaw", "printedSubtotalCents", "confidence", "needsReview"]
      )
    },
    printedTotalRaw: S("图片上的总额原文"),
    printedTotalCents: I("图片上的总额，整数分"),
    statement: obj(
      {
        entries: { type: "ARRAY", items: obj({ date: S("YYYY-MM-DD"), dateRaw: S("日期原文"), orderNumber: S("单号"), cents: I("金额，整数分"), raw: S("金额原文"), paid: { type: "BOOLEAN", nullable: true } }) },
        payments: { type: "ARRAY", items: obj({ date: S("YYYY-MM-DD"), cents: I("金额，整数分"), note: S("备注") }) },
        balanceCents: I("结欠，整数分")
      },
      ["entries", "payments", "balanceCents"],
      { nullable: true, description: "只有 docType 为 statement 时填写，其他为 null" }
    ),
    unparsedLines: { type: "ARRAY", items: { type: "STRING" }, description: "含数字但无法拆成明细的行原文" },
    warnings: { type: "ARRAY", items: { type: "STRING" }, description: "算术不符、涂改、按小计辨认等说明" }
  },
  ["docType", "merchant", "orderNumber", "billDate", "dueDate", "amountDue", "items", "printedTotalRaw", "printedTotalCents", "unparsedLines", "warnings"]
);
var int = (v) => typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
function arithmeticIssues(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const issues = [];
  let sum = 0;
  let complete = items.length > 0;
  for (const [i, it] of items.entries()) {
    const q = typeof it?.quantity === "number" ? it.quantity : null;
    const u = int(it?.unitPriceCents);
    const s = int(it?.printedSubtotalCents);
    const calc = q !== null && u !== null ? Math.round(q * u) : null;
    if (calc !== null && s !== null && calc !== s) issues.push({ row: it?.row ?? i + 1, kind: "row", calc, printed: s });
    const lineTotal = s ?? calc;
    if (lineTotal === null) complete = false;
    else sum += lineTotal;
  }
  const total = int(result?.printedTotalCents);
  if (complete && total !== null && sum !== total) issues.push({ row: null, kind: "total", calc: sum, printed: total });
  return issues;
}
var brl = (c) => (c / 100).toFixed(2).replace(".", ",");
function verifyPrompt(basePrompt, result, issues) {
  const lines = issues.map((x) => x.kind === "row" ? `- 第 ${x.row} 行：数量×单价 = ${brl(x.calc)}，但读到的小计是 ${brl(x.printed)}` : `- 明细合计 ${brl(x.calc)}，但读到的总额是 ${brl(x.printed)}`);
  return `${basePrompt}

【复核】你刚才对这张图片的识别结果如下：
${JSON.stringify({ items: result.items, printedTotalRaw: result.printedTotalRaw ?? null, printedTotalCents: result.printedTotalCents ?? null })}

其中这些地方算术对不上：
${lines.join("\n")}

请重新仔细查看原图上这些行的数量、单价、小计和总额的每一个字符（特别注意 1/7、4/9、5/6、0/6、3/8 等手写混淆），然后按同一 Schema 输出完整 JSON。
规则：清楚可读的数字不得为了凑数而修改；确实读错的改正并在 warnings 写「复核第 N 行：X 改为 Y」；如果原单据本身就算错了，保持读数，在 warnings 写「原单据第 N 行算术不符」。`;
}
function acceptVerified(first, second) {
  if (!second || typeof second !== "object" || !Array.isArray(second.items)) return false;
  const n1 = Array.isArray(first?.items) ? first.items.length : 0;
  if (second.items.length < Math.ceil(n1 * 0.8)) return false;
  return arithmeticIssues(second).length < arithmeticIssues(first).length;
}

// server/core.mjs
var MEDIA_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp"]);
function extractJson(text) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return void 0;
    }
  };
  let v = tryParse(text.trim());
  if (v !== void 0) return v;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (v = tryParse(fence[1])) !== void 0) return v;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a && (v = tryParse(text.slice(a, b + 1))) !== void 0) return v;
  return void 0;
}
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function createHandler({ prompt, log: log2 = () => {
}, authorize = null, health = null }) {
  const hits = /* @__PURE__ */ new Map();
  const cfg = (env) => {
    const gKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
    const aKey = env.ANTHROPIC_API_KEY || "";
    const want = String(env.AI_PROVIDER || "").toLowerCase();
    const provider = want === "anthropic" && aKey ? "anthropic" : want === "gemini" && gKey ? "gemini" : gKey ? "gemini" : aKey ? "anthropic" : null;
    return {
      provider,
      apiKey: provider === "gemini" ? gKey : aKey,
      model: provider === "gemini" ? env.GEMINI_MODEL || "gemini-3.8-flash" : env.ANTHROPIC_MODEL || "claude-sonnet-5",
      apiUrl: provider === "gemini" ? env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta" : env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages",
      thinking: env.GEMINI_THINKING === "off" ? "" : env.GEMINI_THINKING || "low",
      /** 结构化输出（字段不会错位）；个别模型不支持时自动关闭 */
      schema: env.GEMINI_SCHEMA !== "off",
      /** 算术对不上时自动复核一遍 */
      verify: env.RECOGNIZE_VERIFY !== "off",
      fallbacks: String(env.GEMINI_FALLBACK_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean),
      /** 整个识别请求的时间预算（Supabase 函数最长约 150 秒） */
      budget: Number(env.RECOGNIZE_BUDGET_MS || 12e4),
      origins: String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
      tokens: String(env.ACCESS_TOKEN || "").split(",").map((s) => s.trim()).filter(Boolean),
      maxBytes: Number(env.MAX_IMAGE_BYTES || 6 * 1024 * 1024),
      timeout: Number(env.RECOGNIZE_TIMEOUT_MS || 9e4),
      rate: Number(env.RATE_PER_MIN || 10)
    };
  };
  const KEY_ENV = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
  function rateLimited(key, limit) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < 6e4);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5e3) hits.clear();
    return arr.length > limit;
  }
  function corsHeaders(request, c) {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (c.origins.includes("*") || c.origins.includes(origin)) {
      return {
        "access-control-allow-origin": origin,
        vary: "Origin",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-access-token,apikey,authorization,x-client-info",
        "access-control-max-age": "86400"
      };
    }
    return {};
  }
  const json = (status, obj2, extra = {}) => new Response(JSON.stringify(obj2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
  async function post(c, url, headers, body, timeout = c.timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      if (e && e.name === "AbortError") throw new HttpError(504, "识别超时，请重试或裁小图片");
      throw new HttpError(502, "连接视觉模型失败");
    } finally {
      clearTimeout(timer);
    }
  }
  function upstreamMessage(detail) {
    try {
      const j = JSON.parse(detail);
      const m = j?.error?.message || j?.message || "";
      return String(m).replace(/\s+/g, " ").slice(0, 160);
    } catch {
      return "";
    }
  }
  function upstreamError(c, status, detail = "", model = c.model) {
    const msg = upstreamMessage(detail);
    log2(`[recognize] upstream ${c.provider} ${model} HTTP ${status}${msg ? " · " + msg : ""}`);
    const keyName = KEY_ENV[c.provider];
    if (status === 503 || status === 529 || status === 500) return new HttpError(503, `模型「${model}」暂时繁忙（${status}），已自动重试，请过一会儿再点「重试」`);
    if (status === 401 || status === 403 || status === 400 && /API key|API_KEY/i.test(detail)) return new HttpError(502, `模型密钥无效或没有权限，请检查服务器上的 ${keyName}`);
    if (status === 429) return new HttpError(429, "模型服务繁忙或今日免费额度已用完，请稍后再试");
    if (status === 404) return new HttpError(502, `模型「${model}」不可用，请检查 ${c.provider === "gemini" ? "GEMINI_MODEL" : "ANTHROPIC_MODEL"}`);
    if (status === 400 && /location|region|not supported/i.test(detail)) return new HttpError(502, "模型服务在当前地区不可用");
    return new HttpError(502, `模型服务出错（${status}）${msg ? "：" + msg : ""}`);
  }
  const sleep = (ms2) => new Promise((r) => setTimeout(r, ms2));
  const RETRYABLE = /* @__PURE__ */ new Set([500, 502, 503, 504, 529]);
  async function callAnthropic(c, mediaType, imageBase64, fullPrompt = prompt) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await post(c, c.apiUrl, { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }, {
        model: c.model,
        max_tokens: 6e3,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: fullPrompt }
            ]
          }
        ]
      });
      if (r.ok || !RETRYABLE.has(r.status) || attempt === 2) break;
      await sleep(1500 * (attempt + 1));
    }
    if (!r.ok) throw upstreamError(c, r.status, await r.text().catch(() => ""));
    const data = await r.json();
    return (data.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
  }
  let modelCache = null;
  async function discoverModels(c) {
    if (modelCache && modelCache.key === c.apiKey && Date.now() - modelCache.at < 36e5) return modelCache.list;
    let list = [];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6e3);
      const r = await fetch(`${c.apiUrl.replace(/\/$/, "")}/models?pageSize=200`, { headers: { "x-goog-api-key": c.apiKey }, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
        list = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, "")).filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !/image|tts|audio|live|native|embed|computer|robotics/.test(n)).sort((a, b) => Number(/lite/.test(a)) - Number(/lite/.test(b)) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || ver(b) - ver(a));
        log2(`[recognize] available flash models: ${list.slice(0, 8).join(", ") || "(none)"}`);
      } else log2(`[recognize] list models HTTP ${r.status}`);
    } catch {
      log2("[recognize] list models failed");
    }
    modelCache = { key: c.apiKey, at: Date.now(), list };
    return list;
  }
  async function callGemini(c, mediaType, imageBase64, fullPrompt = prompt) {
    const started = Date.now();
    const queue = [c.model, ...c.fallbacks.filter((m) => m !== c.model)];
    let discovered = false;
    let thinking = c.thinking;
    let schema = c.schema;
    const errors = [];
    for (let i = 0; i < queue.length && i < 4; i++) {
      const model = queue[i];
      let modelErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = c.budget - (Date.now() - started);
        if (left < 8e3) {
          modelErr = modelErr || new HttpError(504, "识别超时，请重试或裁小图片");
          i = queue.length;
          break;
        }
        const generationConfig = { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 16384 };
        if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
        if (schema) generationConfig.responseSchema = RECOGNIZE_SCHEMA;
        const url = `${c.apiUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
        let r;
        try {
          r = await post(c, url, { "x-goog-api-key": c.apiKey }, {
            contents: [{ role: "user", parts: [{ inline_data: { mime_type: mediaType, data: imageBase64 } }, { text: fullPrompt }] }],
            generationConfig
          }, Math.min(c.timeout, left));
        } catch (e) {
          modelErr = e;
          if (e instanceof HttpError && e.status === 504) break;
          continue;
        }
        if (r.ok) {
          const data = await r.json();
          if (data.promptFeedback?.blockReason) throw new HttpError(422, "图片被模型安全策略拦截，请换一张或手工录入");
          const cand = (data.candidates || [])[0];
          const text = (cand?.content?.parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
          if (text) {
            if (model !== c.model) log2(`[recognize] used fallback model ${model}`);
            return text;
          }
          if (cand?.finishReason === "MAX_TOKENS") throw new HttpError(502, "识别结果太长被截断，请把单据裁成两部分分别识别");
          modelErr = new HttpError(502, "模型没有返回识别结果，请重试");
          continue;
        }
        const detail = await r.text().catch(() => "");
        if (r.status === 400 && schema && /schema|response_?schema|Unknown name|Invalid JSON payload/i.test(detail)) {
          schema = false;
          log2(`[recognize] ${model} 不支持 responseSchema，已改用纯提示词`);
          attempt--;
          continue;
        }
        if (r.status === 400 && thinking && /thinking/i.test(detail)) {
          thinking = "";
          attempt--;
          continue;
        }
        modelErr = upstreamError(c, r.status, detail, model);
        modelErr.notFound = r.status === 404;
        if (r.status === 404) break;
        if (r.status === 429 && /quota|exhaust/i.test(detail)) break;
        if (!RETRYABLE.has(r.status)) throw modelErr;
        await sleep(1200 * (attempt + 1));
      }
      if (modelErr) errors.push(modelErr);
      if (i === queue.length - 1 && !discovered) {
        discovered = true;
        for (const m of await discoverModels(c)) if (!queue.includes(m)) queue.push(m);
      }
    }
    throw errors.find((e) => !e.notFound) || errors[0] || new HttpError(502, "模型服务出错");
  }
  async function recognize(request, c) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > c.maxBytes * 1.4 + 2048) throw new HttpError(413, "图片过大");
    const body = await request.text();
    if (body.length > c.maxBytes * 1.4 + 2048) throw new HttpError(413, "图片过大");
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new HttpError(400, "请求不是 JSON");
    }
    const { mediaType, imageBase64, hints } = payload || {};
    if (hints != null && typeof hints !== "string") throw new HttpError(400, "参考资料格式错误");
    const fullPrompt = withHints(prompt, hints);
    if (!MEDIA_TYPES.has(mediaType)) throw new HttpError(415, "只接受 JPG、PNG、WebP 图片");
    if (typeof imageBase64 !== "string" || !imageBase64 || !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw new HttpError(400, "图片数据无效");
    if (imageBase64.length * 3 / 4 > c.maxBytes) throw new HttpError(413, "图片过大");
    const started = Date.now();
    const call = (cc, p) => cc.provider === "gemini" ? callGemini(cc, mediaType, imageBase64, p) : callAnthropic(cc, mediaType, imageBase64, p);
    const parse = (text2) => {
      let r = extractJson(text2);
      if (Array.isArray(r) && r.length === 1 && r[0] && typeof r[0] === "object") r = r[0];
      if (!r || typeof r !== "object" || Array.isArray(r)) return null;
      if (!Array.isArray(r.items)) {
        if (r.items != null) return null;
        r.items = [];
      }
      return r;
    };
    let text = await call(c, fullPrompt);
    let result = parse(text);
    if (!result && Date.now() - started < c.budget * 0.5) {
      log2("[recognize] 结果不是有效 JSON，自动重试");
      text = await call({ ...c, budget: c.budget - (Date.now() - started) - 3e3 }, fullPrompt);
      result = parse(text);
    }
    if (!result) throw new HttpError(502, "模型没有返回符合格式的 JSON，请重试");
    let verified = null;
    const issues = c.verify && result.docType !== "statement" ? arithmeticIssues(result) : [];
    const left = c.budget - (Date.now() - started);
    if (issues.length && left > 4e4) {
      try {
        const t2 = await call({ ...c, budget: left - 5e3, fallbacks: [] }, verifyPrompt(fullPrompt, result, issues));
        const second = parse(t2);
        if (acceptVerified(result, second)) {
          verified = { before: issues.length, after: arithmeticIssues(second).length };
          second.warnings = [...Array.isArray(second.warnings) ? second.warnings : [], `已自动复核算术不符的地方（${issues.length} 处 → ${verified.after} 处）`];
          result = second;
          text = t2;
        } else if (second && Array.isArray(second.warnings)) {
          const extra = second.warnings.filter((w) => typeof w === "string" && /复核|原单据/.test(w));
          result.warnings = [...Array.isArray(result.warnings) ? result.warnings : [], ...extra];
        }
        log2(`[recognize] verify ${issues.length} issue(s) → ${verified ? verified.after : "kept first"}`);
      } catch (e) {
        log2(`[recognize] verify skipped: ${e?.message ?? e}`);
      }
    }
    return { result, rawText: text.slice(0, 2e4), model: c.model, ms: Date.now() - started, verified };
  }
  return async function handle2(request, env = {}) {
    const c = cfg(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return null;
    const cors2 = corsHeaders(request, c);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors2 });
    const given = request.headers.get("x-access-token") || request.headers.get("apikey") || "";
    const tokenOk = !c.tokens.length || c.tokens.some((t) => safeEqual(given, t));
    if (url.pathname === "/api/health") {
      const extra = health ? await health(request, env).catch(() => ({})) : {};
      return json(200, { ok: true, configured: Boolean(c.apiKey), provider: c.provider, model: c.apiKey ? c.model : null, auth: c.tokens.length > 0, tokenOk, ...extra }, cors2);
    }
    if (url.pathname === "/api/recognize") {
      if (request.method !== "POST") return json(405, { error: "只支持 POST" }, cors2);
      if (!c.apiKey) return json(503, { error: "服务器未配置模型密钥（GEMINI_API_KEY 或 ANTHROPIC_API_KEY）" }, cors2);
      const ip = request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
      let grant = null;
      if (authorize) {
        grant = await authorize(request, env);
        if (!grant.ok) return json(grant.status || 401, { error: grant.error, code: grant.code }, cors2);
      } else if (!tokenOk) {
        if (rateLimited(`bad:${ip}`, 5)) return json(429, { error: "口令错误次数过多，请稍后再试" }, cors2);
        return json(401, { error: "访问口令不正确，请在「设置 → 识别服务」里填写" }, cors2);
      }
      if (rateLimited(grant?.key || ip, c.rate)) {
        await grant?.done?.(false);
        return json(429, { error: "请求太频繁，请一分钟后再试" }, cors2);
      }
      try {
        const t0 = Date.now();
        const out = await recognize(request, c);
        log2(`[recognize] ok ${Date.now() - t0}ms items=${out.result.items.length}`);
        const usage = grant?.done ? await grant.done(true) : void 0;
        return json(200, usage ? { ...out, usage } : out, cors2);
      } catch (e) {
        await grant?.done?.(false);
        return json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : "服务器内部错误" }, cors2);
      }
    }
    return json(404, { error: "not found" }, cors2);
  };
}

// src/lib/dates.ts
var TZ = "America/Sao_Paulo";
function todayISO(now = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function isoToUTCms(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function diffDays(a, b) {
  return Math.round((isoToUTCms(b) - isoToUTCms(a)) / 864e5);
}
function relativeDue(dueISO, today) {
  const n = diffDays(today, dueISO);
  if (n === 0) return "今天到期";
  if (n === 1) return "明天到期";
  if (n > 1) return `${n} 天后到期`;
  return `逾期 ${-n} 天`;
}

// src/lib/money.ts
function sumCents(values) {
  let t = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error("sumCents 只接受整数分");
    t += v;
  }
  return t;
}
function formatBRL(cents, withSymbol = true) {
  if (cents === null || cents === void 0 || !Number.isFinite(cents)) return "—";
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int2 = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, "0");
  const intStr = String(int2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${withSymbol ? "R$ " : ""}${intStr},${dec}`;
}

// src/lib/payments.ts
function paymentsOf(b) {
  if (b.payments?.length) return [...b.payments].sort((x, y) => x.date.localeCompare(y.date));
  if (b.paidAt) return [{ id: `${b.id}-legacy`, date: todayISO(new Date(b.paidAt)), cents: b.totalCents }];
  return [];
}
var paidCents = (b) => sumCents(paymentsOf(b).map((p) => p.cents));
var openCents = (b) => b.paidAt ? 0 : Math.max(0, b.totalCents - paidCents(b));
var isPartial = (b) => !b.paidAt && paidCents(b) > 0;

// src/lib/status.ts
function billStatus(bill, today, dueSoonDays = 7) {
  if (bill.paidAt) return "paid";
  const left = diffDays(today, bill.dueDate);
  if (left < 0) return "overdue";
  if (left <= dueSoonDays) return "dueSoon";
  return "open";
}
function inReminderWindow(bill, today) {
  if (bill.paidAt) return false;
  return diffDays(today, bill.dueDate) <= bill.reminderDays;
}

// server/webpush.mjs
var enc = new TextEncoder();
function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - s.length % 4) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u(raw), privateJwk };
}
async function vapidAuthorization(endpoint, vapid, subject = "mailto:noreply@example.com", now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1e3) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`)));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function encryptPayload(plaintext, p256dh, auth, opts = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("订阅密钥格式不正确");
  const as = opts.serverKeys ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
async function sendPush(sub, payload, vapid, { subject, ttl = 86400, fetchImpl = fetch, urgency = "normal" } = {}) {
  const body = await encryptPayload(enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload)), sub.p256dh, sub.auth);
  const r = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(sub.endpoint, vapid, subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttl),
      urgency
    },
    body
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}

// shared/plans.mjs
var TRIAL = { days: 30, ai: 10 };
var PLANS = {
  t1: { name: "T1", month: 7.99, year: 79.9, ai: 20, push: true, export: false },
  t2: { name: "T2", month: 19.9, year: 199, ai: 50, push: true, export: true }
};
var AI_PACK = { qty: 20, price: 4.9 };
var STORE = {
  apple: {
    "t1.month": "zq.t1.monthly",
    "t1.year": "zq.t1.yearly",
    "t2.month": "zq.t2.monthly",
    "t2.year": "zq.t2.yearly",
    ai_pack: "zq.ai20"
  },
  google: {
    t1: "zq_t1",
    t2: "zq_t2",
    basePlan: { month: "monthly", year: "yearly" },
    ai_pack: "zq_ai20"
  }
};
function planOfProduct(store, productId, basePlanId = null) {
  if (store === "apple") {
    for (const [k, v] of Object.entries(STORE.apple)) {
      if (v !== productId || k === "ai_pack") continue;
      const [plan2, period2] = k.split(".");
      return { plan: plan2, period: period2 };
    }
    return null;
  }
  const plan = productId === STORE.google.t1 ? "t1" : productId === STORE.google.t2 ? "t2" : null;
  if (!plan) return null;
  const period = basePlanId === STORE.google.basePlan.year ? "year" : "month";
  return { plan, period };
}
function bestSub(subs, now = /* @__PURE__ */ new Date()) {
  const t = now.getTime();
  const live = (subs || []).filter((s) => (s.plan === "t1" || s.plan === "t2") && ["active", "grace", "canceled"].includes(s.status) && s.until && Date.parse(s.until) > t);
  live.sort((a, b) => a.plan === b.plan ? Date.parse(b.until) - Date.parse(a.until) : a.plan === "t2" ? -1 : 1);
  return live[0] ?? null;
}
function monthKey(d = /* @__PURE__ */ new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
}
var ms = (iso) => iso ? Date.parse(iso) : NaN;
function entitlement(profile, { email = "", owners = [], now = /* @__PURE__ */ new Date(), plans = PLANS, trial = TRIAL } = {}) {
  const t = now.getTime();
  const trialUntil = profile?.trial_until ?? null;
  const planUntil = profile?.plan_until ?? null;
  const rawPlan = profile?.plan === "pro" ? "t2" : profile?.plan;
  let plan;
  if (profile?.plan === "owner" || email && owners.includes(String(email).toLowerCase())) plan = "owner";
  else if ((rawPlan === "t1" || rawPlan === "t2") && ms(planUntil) > t) plan = rawPlan;
  else if (ms(trialUntil) > t) plan = "trial";
  else plan = "expired";
  const p = plan === "t1" || plan === "t2" ? plans[plan] : null;
  const features = {
    edit: plan !== "expired",
    push: plan === "owner" || !!p?.push,
    export: plan === "owner" || !!p?.export
  };
  const ai = plan === "owner" ? { key: monthKey(now), limit: -1 } : p ? { key: monthKey(now), limit: p.ai } : plan === "trial" ? { key: "trial", limit: trial.ai } : { key: null, limit: 0 };
  const until = plan === "trial" ? trialUntil : p ? planUntil : null;
  const daysLeft = until ? Math.max(0, Math.ceil((ms(until) - t) / 864e5)) : null;
  return { plan, period: p ? profile?.period ?? "month" : null, trialUntil, planUntil, features, ai, daysLeft };
}
function priceOf(plan, period, plans = PLANS) {
  const p = plans[plan];
  if (!p || period !== "month" && period !== "year") return null;
  return p[period];
}

// supabase/stores.mjs
var enc2 = new TextEncoder();
var b64u2 = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
var b64uJson = (o) => b64u2(enc2.encode(JSON.stringify(o)));
function unb64u2(s) {
  const p = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - p.length % 4) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
function decodeJws(jws) {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unb64u2(parts[1])));
  } catch {
    return null;
  }
}
function pemToDer(pem) {
  const body = String(pem).replace(/\\n/g, "\n").replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return unb64u2(body.replace(/\+/g, "-").replace(/\//g, "_"));
}
async function signJwt(alg, pem, header, payload) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const input = `${b64uJson({ alg, typ: "JWT", ...header })}.${b64uJson(payload)}`;
  const sig = await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, key, enc2.encode(input));
  return `${input}.${b64u2(sig)}`;
}
var StoreError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
function appleConfigured(c) {
  return !!(c.apple.bundleId && c.apple.issuer && c.apple.keyId && c.apple.key);
}
function createApple(c, fetchImpl, now = () => /* @__PURE__ */ new Date()) {
  let cached = { token: "", exp: 0 };
  async function token() {
    const t = Math.floor(now().getTime() / 1e3);
    if (cached.token && cached.exp - 60 > t) return cached.token;
    const jwt = await signJwt("ES256", c.apple.key, { kid: c.apple.keyId }, { iss: c.apple.issuer, iat: t, exp: t + 1200, aud: "appstoreconnect-v1", bid: c.apple.bundleId });
    cached = { token: jwt, exp: t + 1200 };
    return jwt;
  }
  async function get(path) {
    if (!appleConfigured(c)) throw new StoreError(503, "还没配置 App Store 内购校验（APPLE_* 密钥）", "store_off");
    const auth = { authorization: `Bearer ${await token()}` };
    for (const base of [c.apple.api, c.apple.sandbox]) {
      const r = await fetchImpl(`${base}${path}`, { headers: auth });
      if (r.status === 404) continue;
      const text = await r.text();
      if (!r.ok) throw new StoreError(502, `App Store 校验失败（${r.status}）`, "store_error");
      return { data: JSON.parse(text), sandbox: base === c.apple.sandbox };
    }
    throw new StoreError(404, "在 App Store 找不到这笔交易", "not_found");
  }
  return {
    /** 单笔交易 */
    async transaction(transactionId) {
      const { data, sandbox } = await get(`/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
      const tx = decodeJws(data.signedTransactionInfo);
      if (!tx) throw new StoreError(502, "App Store 返回的交易无法解析");
      if (tx.bundleId && tx.bundleId !== c.apple.bundleId) throw new StoreError(400, "交易不属于这个 App", "wrong_app");
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
      if (!best) throw new StoreError(404, "找不到订阅状态", "not_found");
      return best;
    }
  };
}
var APPLE_STATUS = { 1: "active", 2: "expired", 3: "expired", 4: "grace", 5: "revoked" };
function googleConfigured(c) {
  return !!(c.google.packageName && c.google.account?.client_email && c.google.account?.private_key);
}
function createGoogle(c, fetchImpl, now = () => /* @__PURE__ */ new Date()) {
  let cached = { token: "", exp: 0 };
  async function token() {
    const t = Math.floor(now().getTime() / 1e3);
    if (cached.token && cached.exp - 60 > t) return cached.token;
    const sa = c.google.account;
    const assertion = await signJwt("RS256", sa.private_key, sa.private_key_id ? { kid: sa.private_key_id } : {}, {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: c.google.tokenUrl,
      iat: t,
      exp: t + 3600
    });
    const r = await fetchImpl(c.google.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new StoreError(502, `Google 服务账号登录失败（${r.status}）`, "store_error");
    cached = { token: j.access_token, exp: t + Number(j.expires_in || 3600) };
    return cached.token;
  }
  async function call(method, path) {
    if (!googleConfigured(c)) throw new StoreError(503, "还没配置 Google Play 内购校验（GOOGLE_* 密钥）", "store_off");
    const r = await fetchImpl(`${c.google.api}/androidpublisher/v3/applications/${encodeURIComponent(c.google.packageName)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : void 0
    });
    const text = await r.text();
    if (r.status === 404 || r.status === 410) throw new StoreError(404, "在 Google Play 找不到这笔购买", "not_found");
    if (!r.ok) throw new StoreError(502, `Google Play 校验失败（${r.status}）`, "store_error");
    return text ? JSON.parse(text) : {};
  }
  const tok = (t) => encodeURIComponent(String(t));
  return {
    subscription: (purchaseToken) => call("GET", `/purchases/subscriptionsv2/tokens/${tok(purchaseToken)}`),
    acknowledgeSubscription: (productId, purchaseToken) => call("POST", `/purchases/subscriptions/${tok(productId)}/tokens/${tok(purchaseToken)}:acknowledge`),
    product: (productId, purchaseToken) => call("GET", `/purchases/products/${tok(productId)}/tokens/${tok(purchaseToken)}`),
    consume: (productId, purchaseToken) => call("POST", `/purchases/products/${tok(productId)}/tokens/${tok(purchaseToken)}:consume`)
  };
}
var GOOGLE_STATE = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_ON_HOLD: "expired",
  SUBSCRIPTION_STATE_PAUSED: "expired",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired"
};

// supabase/saas.mjs
var ApiError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
function saasConfig(env) {
  const get = (k) => env[k] || "";
  let secret = "";
  try {
    const j = JSON.parse(get("SUPABASE_SECRET_KEYS") || "{}");
    secret = j.default || Object.values(j)[0] || "";
  } catch {
  }
  secret = secret || get("SUPABASE_SERVICE_ROLE_KEY");
  let publishable = "";
  try {
    const j = JSON.parse(get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    publishable = j.default || Object.values(j)[0] || "";
  } catch {
  }
  publishable = publishable || get("SUPABASE_ANON_KEY");
  return {
    url: get("SUPABASE_URL").replace(/\/+$/, ""),
    secret,
    publishable,
    anon: get("SUPABASE_ANON_KEY"),
    mpToken: get("MP_ACCESS_TOKEN"),
    mpWebhookSecret: get("MP_WEBHOOK_SECRET"),
    mpApi: get("MP_API_URL") || "https://api.mercadopago.com",
    owners: get("OWNER_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowKeyOnly: /^(1|true|yes|on)$/i.test(get("ALLOW_KEY_ONLY")),
    pushSubject: get("PUSH_SUBJECT") || "mailto:noreply@zhangqi.app",
    apple: {
      bundleId: get("APPLE_BUNDLE_ID"),
      issuer: get("APPLE_ISSUER_ID"),
      keyId: get("APPLE_KEY_ID"),
      key: get("APPLE_PRIVATE_KEY"),
      api: get("APPLE_API_URL") || "https://api.storekit.itunes.apple.com",
      sandbox: get("APPLE_SANDBOX_API_URL") || "https://api.storekit-sandbox.itunes.apple.com"
    },
    google: {
      packageName: get("GOOGLE_PACKAGE_NAME"),
      account: (() => {
        try {
          return JSON.parse(get("GOOGLE_SERVICE_ACCOUNT") || "null");
        } catch {
          return null;
        }
      })(),
      api: get("GOOGLE_API_URL") || "https://androidpublisher.googleapis.com",
      tokenUrl: get("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token",
      rtdnToken: get("GOOGLE_RTDN_TOKEN")
    }
  };
}
function createSaas({ fetchImpl = (...a) => fetch(...a), log: log2 = () => {
}, now = () => /* @__PURE__ */ new Date() } = {}) {
  function dbHeaders(c, extra = {}) {
    const h = { apikey: c.secret, "content-type": "application/json", ...extra };
    if (c.secret.startsWith("eyJ")) h.authorization = `Bearer ${c.secret}`;
    return h;
  }
  async function db(c, path, init = {}) {
    if (!c.url || !c.secret) throw new ApiError(500, "函数缺少 SUPABASE_URL 或 service key");
    const r = await fetchImpl(`${c.url}/rest/v1/${path}`, { ...init, headers: dbHeaders(c, init.headers) });
    const text = await r.text();
    if (!r.ok) {
      log2(`[saas] db ${path.split("?")[0]} HTTP ${r.status} ${text.slice(0, 160)}`);
      if (/does not exist|PGRST20[25]|Could not find/i.test(text)) throw new ApiError(500, "数据库还没升级：请在 Supabase SQL Editor 重新运行最新的 setup.sql", "no_setup");
      throw new ApiError(500, `数据库错误（${r.status}）`);
    }
    return text ? JSON.parse(text) : null;
  }
  const rpc = (c, fn, args) => db(c, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  async function kvGet(c, key) {
    const rows = await db(c, `zq_kv?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows?.[0]?.value ?? null;
  }
  async function kvSet(c, key, value) {
    await db(c, "zq_kv", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: now().toISOString() }) });
  }
  const userCache = /* @__PURE__ */ new Map();
  async function getUser(c, request) {
    const h = request.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    if (token === c.publishable || token === c.anon || token.startsWith("sb_")) return null;
    const hit = userCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    const r = await fetchImpl(`${c.url}/auth/v1/user`, { headers: { apikey: c.publishable || c.secret, authorization: `Bearer ${token}` } });
    if (!r.ok) throw new ApiError(401, "登录已过期，请重新登录", "session_expired");
    const u = await r.json();
    if (!u?.id) throw new ApiError(401, "登录已过期，请重新登录", "session_expired");
    const user = { id: u.id, email: String(u.email || "").toLowerCase() };
    userCache.set(token, { user, exp: Date.now() + 6e4 });
    if (userCache.size > 500) userCache.clear();
    return user;
  }
  async function requireUser(c, request) {
    const u = await getUser(c, request);
    if (!u) throw new ApiError(401, "请先登录（设置 → 账号）", "login_required");
    return u;
  }
  async function getProfile(c, user) {
    const rows = await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`);
    let p = rows?.[0];
    if (!p) {
      await db(c, "zq_profiles", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ user_id: user.id, email: user.email }) });
      p = (await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`))?.[0] ?? { user_id: user.id, email: user.email, plan: null, trial_until: new Date(now().getTime() + TRIAL.days * 864e5).toISOString() };
    }
    if (c.owners.includes(user.email) && p.plan !== "owner") {
      await db(c, `zq_profiles?user_id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ plan: "owner", updated_at: now().toISOString() }) });
      p = { ...p, plan: "owner" };
    }
    return p;
  }
  const entOf = (c, user, profile) => entitlement(profile, { email: user.email, owners: c.owners, now: now() });
  async function usedOf(c, user, key) {
    if (!key) return 0;
    const rows = await db(c, `zq_usage?user_id=eq.${user.id}&month=eq.${encodeURIComponent(key)}&select=ai`);
    return rows?.[0]?.ai ?? 0;
  }
  async function authorizeRecognize(request, env) {
    const c = saasConfig(env);
    let user;
    try {
      user = await getUser(c, request);
    } catch (e) {
      return { ok: false, status: e.status || 401, error: e.message, code: e.code };
    }
    if (!user) {
      if (c.allowKeyOnly) {
        const given = request.headers.get("apikey") || request.headers.get("x-access-token") || "";
        const keys = [c.publishable, env.SUPABASE_ANON_KEY, ...String(env.ACCESS_TOKEN || "").split(",")].filter(Boolean);
        return keys.includes(given) ? { ok: true } : { ok: false, status: 401, error: "访问口令不正确" };
      }
      return { ok: false, status: 401, error: "AI 识别需要先登录账号", code: "login_required" };
    }
    try {
      const ent = entOf(c, user, await getProfile(c, user));
      if (ent.plan === "expired") return { ok: false, status: 402, code: "expired", error: "试用已结束：订阅 T1 或 T2 后继续使用 AI 识别" };
      let n = await rpc(c, "zq_usage_take", { p_user: user.id, p_month: ent.ai.key, p_limit: ent.ai.limit });
      let fromBonus = false;
      if (n === -1 || n === null) {
        const left = await rpc(c, "zq_bonus_take", { p_user: user.id });
        if (left === -1 || left === null) {
          const tail = `，或买 AI 加量包（${AI_PACK.qty} 次）`;
          const msg = ent.plan === "trial" ? `试用期的 ${ent.ai.limit} 次 AI 识别已用完：订阅后每月 ${PLANS.t1.ai}～${PLANS.t2.ai} 次${tail}` : ent.plan === "t1" ? `本月 ${ent.ai.limit} 次 AI 识别已用完：升级 T2 每月 ${PLANS.t2.ai} 次${tail}` : `本月 ${ent.ai.limit} 次 AI 识别已用完${tail}，或等下月 1 日恢复`;
          return { ok: false, status: 402, code: "quota", error: msg };
        }
        fromBonus = true;
        n = ent.ai.limit;
      }
      return {
        ok: true,
        key: `u:${user.id}`,
        done: async (success) => {
          if (!success) {
            await (fromBonus ? rpc(c, "zq_bonus_refund", { p_user: user.id }) : rpc(c, "zq_usage_refund", { p_user: user.id, p_month: ent.ai.key })).catch(() => {
            });
            return void 0;
          }
          return { used: n, limit: ent.ai.limit, plan: ent.plan, fromBonus };
        }
      };
    } catch (e) {
      return { ok: false, status: e.status || 500, error: e.message, code: e.code };
    }
  }
  const storesOn = (c) => ({ apple: appleConfigured(c), google: googleConfigured(c) });
  async function subsOf(c, userId) {
    return await db(c, `zq_subs?user_id=eq.${userId}&select=*`) ?? [];
  }
  async function me(c, request) {
    const user = await requireUser(c, request);
    let p = await getProfile(c, user);
    if (c.mpToken && p.mp_preapproval_id && p.mp_status === "pending") {
      p = await refreshPreapproval(c, p.mp_preapproval_id).catch(() => null) ?? p;
    }
    const ent = entOf(c, user, p);
    await rememberFnUrl(c, request).catch(() => {
    });
    const subs = await subsOf(c, user.id);
    const st = storesOn(c);
    const anyBilling = !!c.mpToken || st.apple || st.google;
    return {
      email: user.email,
      ...ent,
      source: p.plan_source ?? (p.mp_preapproval_id ? "mp" : null),
      autoRenew: p.auto_renew ?? (p.mp_status === "authorized" ? true : null),
      subscription: p.mp_preapproval_id ? { status: p.mp_status ?? null, plan: p.pending_plan ?? null } : null,
      subs: subs.map((x) => ({ source: x.source, plan: x.plan, period: x.period, until: x.until, status: x.status, autoRenew: !!x.auto_renew })),
      usage: { period: ent.ai.key, ai: await usedOf(c, user, ent.ai.key), limit: ent.ai.limit, bonus: p.ai_bonus ?? 0 },
      billing: anyBilling ? { currency: "BRL", plans: PLANS, trial: TRIAL, pack: AI_PACK, web: !!c.mpToken, stores: st, products: STORE } : null,
      appAccountToken: user.id
    };
  }
  async function applySub(c, userId, sub) {
    await db(c, "zq_subs", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ...sub, user_id: userId, updated_at: now().toISOString() })
    });
    return recompute(c, userId);
  }
  async function recompute(c, userId) {
    const subs = await subsOf(c, userId);
    const cur = (await db(c, `zq_profiles?user_id=eq.${userId}&select=*`))?.[0];
    if (!cur || !subs.length) return cur;
    const best = bestSub(subs, now());
    const pick = best ?? [...subs].filter((x) => x.until && x.status !== "pending").sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
    if (!pick) return cur;
    const patch = {
      plan: cur.plan === "owner" ? "owner" : pick.plan,
      period: pick.period,
      plan_until: pick.until,
      plan_source: pick.source,
      auto_renew: !!pick.auto_renew && pick.status !== "canceled",
      updated_at: now().toISOString()
    };
    await db(c, `zq_profiles?user_id=eq.${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
    return { ...cur, ...patch };
  }
  const userExists = async (c, id) => /^[0-9a-f-]{36}$/i.test(String(id || "")) && !!(await db(c, `zq_profiles?user_id=eq.${id}&select=user_id`))?.length;
  async function mp(c, path, init = {}) {
    if (!c.mpToken) throw new ApiError(503, "还没开通订阅收款（服务器未配置 MP_ACCESS_TOKEN）", "billing_off");
    const r = await fetchImpl(`${c.mpApi}${path}`, { ...init, headers: { authorization: `Bearer ${c.mpToken}`, "content-type": "application/json", ...init.headers || {} } });
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!r.ok) {
      log2(`[billing] MP ${path.split("?")[0]} HTTP ${r.status} ${(j?.message || text).slice(0, 200)}`);
      throw new ApiError(502, `Mercado Pago 返回错误（${r.status}）：${j?.message || "请稍后再试"}`);
    }
    return j;
  }
  const parseRef = (ref) => {
    const [userId, plan, period] = String(ref || "").split("|");
    return { userId, plan: plan === "t1" || plan === "t2" ? plan : "t2", period: period === "year" ? "year" : "month" };
  };
  async function refreshPreapproval(c, id) {
    const pa = await mp(c, `/preapproval/${encodeURIComponent(id)}`);
    const ref = parseRef(pa.external_reference);
    if (!ref.userId || !/^[0-9a-f-]{36}$/i.test(ref.userId)) throw new ApiError(400, "订阅缺少用户信息");
    const rows = await db(c, `zq_profiles?user_id=eq.${ref.userId}&select=*`);
    const cur = rows?.[0];
    if (!cur) throw new ApiError(404, "找不到订阅对应的账号");
    const patch = { updated_at: now().toISOString() };
    const isCurrent = !cur.mp_preapproval_id || cur.mp_preapproval_id === pa.id;
    if (pa.status === "authorized") {
      const next = pa.next_payment_date ? Date.parse(pa.next_payment_date) : NaN;
      const fallback = (ref.period === "year" ? 368 : 33) * 864e5;
      const until2 = Number.isFinite(next) ? next + 3 * 864e5 : now().getTime() + fallback;
      const keep = cur.plan === ref.plan && cur.plan_until ? Date.parse(cur.plan_until) : 0;
      Object.assign(patch, { plan: cur.plan === "owner" ? "owner" : ref.plan, period: ref.period, plan_until: new Date(Math.max(until2, keep)).toISOString(), mp_preapproval_id: pa.id, mp_status: "authorized", pending_plan: null });
      const old = cur.mp_preapproval_id && cur.mp_preapproval_id !== pa.id ? cur.mp_preapproval_id : null;
      if (old) {
        await mp(c, `/preapproval/${encodeURIComponent(old)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) }).catch(() => {
        });
        log2(`[billing] switched ${old} -> ${pa.id}`);
      }
    } else if (isCurrent) {
      patch.mp_status = pa.status;
      patch.mp_preapproval_id = pa.id;
    } else if (pa.status === "pending") {
      patch.pending_id = pa.id;
    }
    await db(c, `zq_profiles?user_id=eq.${ref.userId}`, { method: "PATCH", body: JSON.stringify(patch) });
    const prev = (await db(c, `zq_subs?id=eq.${encodeURIComponent("mp:" + pa.id)}&select=until`))?.[0];
    const status = pa.status === "authorized" ? "active" : pa.status === "pending" ? "pending" : "canceled";
    const until = pa.status === "authorized" ? patch.plan_until : prev?.until ?? (isCurrent ? cur.plan_until : null);
    await db(c, "zq_subs", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: `mp:${pa.id}`, user_id: ref.userId, source: "mp", plan: ref.plan, period: ref.period, until, status, auto_renew: pa.status === "authorized", product: "preapproval", updated_at: now().toISOString() })
    });
    const merged = await recompute(c, ref.userId);
    return { ...cur, ...patch, ...merged ?? {} };
  }
  async function once(c, request) {
    const user = await requireUser(c, request);
    const body = await request.json().catch(() => ({}));
    const kind = body.kind;
    const back = String(body.returnUrl || "");
    if (!/^https:\/\/[^\s]+$/.test(back) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(back)) throw new ApiError(400, "返回地址必须是 https 网址");
    let item;
    let ref;
    if (kind === "pix_year") {
      const plan = body.plan;
      const price = priceOf(plan, "year");
      if (price === null) throw new ApiError(400, "请选择套餐（T1 / T2）");
      item = { title: `账期助手 ${PLANS[plan].name} · 1 年（一次付清）`, unit_price: price };
      ref = `${user.id}|pix|${plan}|year`;
    } else if (kind === "ai_pack") {
      item = { title: `账期助手 AI 识别加量包 · ${AI_PACK.qty} 次`, unit_price: AI_PACK.price };
      ref = `${user.id}|pack|ai`;
    } else throw new ApiError(400, "未知的购买项目");
    const fnUrl = await kvGet(c, "fn_url").catch(() => null);
    const pref = await mp(c, "/checkout/preferences", {
      method: "POST",
      body: JSON.stringify({
        items: [{ id: kind, title: item.title, quantity: 1, unit_price: item.unit_price, currency_id: "BRL" }],
        external_reference: ref,
        payer: user.email ? { email: user.email } : void 0,
        back_urls: { success: back, pending: back, failure: back },
        auto_return: "approved",
        ...fnUrl ? { notification_url: `${fnUrl}/billing/webhook?source=once` } : {},
        statement_descriptor: "ZHANGQI"
      })
    });
    if (!pref.init_point) throw new ApiError(502, "Mercado Pago 没有返回付款链接");
    return { url: pref.init_point };
  }
  async function settlePayment(c, id) {
    const pay = await mp(c, `/v1/payments/${encodeURIComponent(id)}`);
    const [userId, kind, plan] = String(pay.external_reference || "").split("|");
    if (!await userExists(c, userId)) return { ignored: true };
    const pid = `mp:${pay.id}`;
    if (pay.status === "approved") {
      if (kind === "pack") {
        await rpc(c, "zq_credit_purchase", { p_id: pid, p_user: userId, p_kind: "ai_pack", p_qty: AI_PACK.qty, p_amount: pay.transaction_amount ?? AI_PACK.price });
        return { ok: true };
      }
      if (kind === "pix" && (plan === "t1" || plan === "t2")) {
        const first = await rpc(c, "zq_credit_purchase", { p_id: pid, p_user: userId, p_kind: "pix_year", p_qty: 0, p_amount: pay.transaction_amount ?? null });
        if (first) {
          const subs = await subsOf(c, userId);
          const sameUntil = subs.filter((x) => x.plan === plan && ["active", "grace", "canceled"].includes(x.status) && x.until).map((x) => Date.parse(x.until));
          const base = Math.max(now().getTime(), ...sameUntil);
          await applySub(c, userId, { id: `pix:${pay.id}`, source: "pix", plan, period: "year", until: new Date(base + 365 * 864e5).toISOString(), status: "active", auto_renew: false, product: "pix_year" });
        }
        return { ok: true };
      }
    }
    if (pay.status === "refunded" || pay.status === "charged_back" || pay.status === "cancelled") {
      await rpc(c, "zq_refund_purchase", { p_id: pid });
      if (kind === "pix") await setSubStatus(c, `pix:${pay.id}`, "revoked");
    }
    return { ok: true };
  }
  async function setSubStatus(c, id, status) {
    const row = (await db(c, `zq_subs?id=eq.${encodeURIComponent(id)}&select=*`))?.[0];
    if (!row) return null;
    const { user_id, ...rest } = row;
    return applySub(c, user_id, { ...rest, status });
  }
  const ms2 = (v) => v == null ? null : typeof v === "number" ? v : Date.parse(v);
  const iso = (v) => ms2(v) ? new Date(ms2(v)).toISOString() : null;
  async function syncApple(c, transactionId, userId = null) {
    const apple = createApple(c, fetchImpl, now);
    const tx = await apple.transaction(transactionId);
    const owner = await ownerOf(c, userId, tx.appAccountToken, `apple:${tx.originalTransactionId}`);
    if (tx.productId === STORE.apple.ai_pack) {
      if (tx.revocationDate) {
        await rpc(c, "zq_refund_purchase", { p_id: `apple:${tx.transactionId}` });
        return { kind: "ai_pack", refunded: true };
      }
      if (!owner) throw new StoreError(400, "这笔购买不属于当前账号", "wrong_account");
      const credited = await rpc(c, "zq_credit_purchase", { p_id: `apple:${tx.transactionId}`, p_user: owner, p_kind: "ai_pack", p_qty: AI_PACK.qty * (tx.quantity || 1), p_amount: tx.price ? tx.price / 1e3 : null });
      return { kind: "ai_pack", credited };
    }
    const pl = planOfProduct("apple", tx.productId);
    if (!pl) throw new StoreError(400, `未知商品 ${tx.productId}`, "unknown_product");
    if (!owner) throw new StoreError(400, "这笔订阅不属于当前账号", "wrong_account");
    const st = await apple.subscription(transactionId);
    const cur = planOfProduct("apple", st.tx.productId) ?? pl;
    const status = st.tx.revocationDate ? "revoked" : APPLE_STATUS[st.status] ?? "expired";
    const autoRenew = st.renewal ? st.renewal.autoRenewStatus === 1 : status === "active";
    await applySub(c, owner, {
      id: `apple:${st.originalTransactionId}`,
      source: "apple",
      plan: cur.plan,
      period: cur.period,
      until: iso(st.renewal?.gracePeriodExpiresDate && status === "grace" ? st.renewal.gracePeriodExpiresDate : st.tx.expiresDate),
      status: status === "active" && !autoRenew ? "canceled" : status,
      auto_renew: autoRenew,
      product: st.tx.productId
    });
    return { kind: "sub", status, plan: cur.plan, period: cur.period };
  }
  async function syncGoogle(c, { productId, purchaseToken }, userId = null) {
    const google = createGoogle(c, fetchImpl, now);
    if (productId === STORE.google.ai_pack) {
      const pr = await google.product(productId, purchaseToken);
      const owner2 = await ownerOf(c, userId, pr.obfuscatedExternalAccountId, null);
      const pid = `google:${pr.orderId || purchaseToken}`;
      if (pr.purchaseState === 1) {
        await rpc(c, "zq_refund_purchase", { p_id: pid });
        return { kind: "ai_pack", refunded: true };
      }
      if (pr.purchaseState !== 0) return { kind: "ai_pack", pending: true };
      if (!owner2) throw new StoreError(400, "这笔购买不属于当前账号", "wrong_account");
      const credited = await rpc(c, "zq_credit_purchase", { p_id: pid, p_user: owner2, p_kind: "ai_pack", p_qty: AI_PACK.qty * (pr.quantity || 1), p_amount: null });
      if (pr.consumptionState === 0) await google.consume(productId, purchaseToken).catch((e) => log2(`[iap] consume ${e.message}`));
      return { kind: "ai_pack", credited };
    }
    const sub = await google.subscription(purchaseToken);
    const li = (sub.lineItems ?? []).slice().sort((a, b) => (ms2(b.expiryTime) ?? 0) - (ms2(a.expiryTime) ?? 0))[0];
    if (!li) throw new StoreError(404, "找不到订阅内容", "not_found");
    const pl = planOfProduct("google", li.productId, li.offerDetails?.basePlanId);
    if (!pl) throw new StoreError(400, `未知商品 ${li.productId}`, "unknown_product");
    const owner = await ownerOf(c, userId, sub.externalAccountIdentifiers?.obfuscatedExternalAccountId, `google:${purchaseToken}`);
    if (!owner) throw new StoreError(400, "这笔订阅不属于当前账号", "wrong_account");
    const status = GOOGLE_STATE[sub.subscriptionState] ?? "expired";
    if (sub.linkedPurchaseToken) await setSubStatus(c, `google:${sub.linkedPurchaseToken}`, "expired").catch(() => {
    });
    await applySub(c, owner, {
      id: `google:${purchaseToken}`,
      source: "google",
      plan: pl.plan,
      period: pl.period,
      until: iso(li.expiryTime),
      status,
      auto_renew: !!li.autoRenewingPlan?.autoRenewEnabled,
      product: `${li.productId}:${li.offerDetails?.basePlanId ?? ""}`
    });
    if (sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && (status === "active" || status === "grace")) {
      await google.acknowledgeSubscription(li.productId, purchaseToken).catch((e) => log2(`[iap] ack ${e.message}`));
    }
    return { kind: "sub", status, plan: pl.plan, period: pl.period };
  }
  async function ownerOf(c, userId, token, subId) {
    const tok = token && /^[0-9a-f-]{36}$/i.test(token) ? token.toLowerCase() : null;
    if (userId) {
      if (tok && tok !== userId) return null;
      if (subId) {
        const row = (await db(c, `zq_subs?id=eq.${encodeURIComponent(subId)}&select=user_id`))?.[0];
        if (row && row.user_id !== userId) return null;
      }
      return userId;
    }
    if (subId) {
      const row = (await db(c, `zq_subs?id=eq.${encodeURIComponent(subId)}&select=user_id`))?.[0];
      if (row) return row.user_id;
    }
    return tok && await userExists(c, tok) ? tok : null;
  }
  async function iapVerify(c, request) {
    const user = await requireUser(c, request);
    await getProfile(c, user);
    const b = await request.json().catch(() => ({}));
    const list = Array.isArray(b.purchases) ? b.purchases.slice(0, 20) : [b];
    const results = [];
    for (const it of list) {
      try {
        if (b.store === "apple" || it.store === "apple") {
          if (!it.transactionId) throw new StoreError(400, "缺少交易 ID");
          results.push(await syncApple(c, String(it.transactionId), user.id));
        } else if (b.store === "google" || it.store === "google") {
          if (!it.purchaseToken || !it.productId) throw new StoreError(400, "缺少购买令牌");
          results.push(await syncGoogle(c, { productId: String(it.productId), purchaseToken: String(it.purchaseToken) }, user.id));
        } else throw new StoreError(400, "未知商店");
      } catch (e) {
        if (list.length === 1) throw e instanceof StoreError ? new ApiError(e.status, e.message, e.code) : e;
        results.push({ error: e.message });
      }
    }
    return { results, me: await me(c, request) };
  }
  async function appleNotify(c, request) {
    const b = await request.json().catch(() => ({}));
    const n = decodeJws(b.signedPayload);
    const tx = decodeJws(n?.data?.signedTransactionInfo);
    if (!tx?.transactionId) return { ignored: true };
    if (tx.bundleId && c.apple.bundleId && tx.bundleId !== c.apple.bundleId) return { ignored: true };
    try {
      const r = await syncApple(c, String(tx.transactionId), null);
      log2(`[iap] apple ${n.notificationType}${n.subtype ? "/" + n.subtype : ""} → ${r.status ?? r.kind}`);
    } catch (e) {
      log2(`[iap] apple notify ${e.message}`);
    }
    return { ok: true };
  }
  async function googleNotify(c, request) {
    const url = new URL(request.url);
    if (!c.google.rtdnToken || url.searchParams.get("token") !== c.google.rtdnToken) throw new ApiError(401, "bad token");
    const b = await request.json().catch(() => ({}));
    let msg = null;
    try {
      msg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b.message?.data || ""), (ch) => ch.charCodeAt(0))));
    } catch {
    }
    if (!msg || msg.packageName && msg.packageName !== c.google.packageName) return { ignored: true };
    try {
      if (msg.subscriptionNotification?.purchaseToken) {
        const r = await syncGoogle(c, { productId: msg.subscriptionNotification.subscriptionId, purchaseToken: msg.subscriptionNotification.purchaseToken }, null);
        log2(`[iap] google sub ${msg.subscriptionNotification.notificationType} → ${r.status}`);
      } else if (msg.oneTimeProductNotification?.purchaseToken) {
        await syncGoogle(c, { productId: msg.oneTimeProductNotification.sku, purchaseToken: msg.oneTimeProductNotification.purchaseToken }, null);
      } else if (msg.voidedPurchaseNotification) {
        const v = msg.voidedPurchaseNotification;
        if (v.productType === 1) await setSubStatus(c, `google:${v.purchaseToken}`, "revoked");
        else await rpc(c, "zq_refund_purchase", { p_id: `google:${v.orderId || v.purchaseToken}` });
      }
    } catch (e) {
      log2(`[iap] google notify ${e.message}`);
    }
    return { ok: true };
  }
  async function reconcileStores(c) {
    const soon = new Date(now().getTime() + 2 * 864e5).toISOString();
    const rows = await db(c, `zq_subs?source=in.(apple,google)&select=*`) ?? [];
    let n = 0;
    for (const r of rows) {
      if (!["active", "grace", "canceled"].includes(r.status) || r.until && r.until > soon) continue;
      try {
        if (r.source === "apple" && appleConfigured(c)) await syncApple(c, r.id.slice(6), r.user_id);
        if (r.source === "google" && googleConfigured(c)) await syncGoogle(c, { productId: String(r.product || "").split(":")[0], purchaseToken: r.id.slice(7) }, r.user_id);
        n++;
      } catch (e) {
        log2(`[iap] reconcile ${r.id.slice(0, 20)} ${e.message}`);
      }
    }
    return n;
  }
  async function deleteAccount(c, request) {
    const user = await requireUser(c, request);
    const b = await request.json().catch(() => ({}));
    if (b.confirm !== user.email && b.confirm !== "DELETE") throw new ApiError(400, "请输入你的邮箱确认删除");
    const p = (await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`))?.[0];
    const subs = await subsOf(c, user.id);
    if (c.mpToken && p?.mp_preapproval_id && p.mp_status === "authorized") {
      await mp(c, `/preapproval/${encodeURIComponent(p.mp_preapproval_id)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) }).catch(() => {
      });
    }
    await rpc(c, "zq_delete_space", { p_user: user.id });
    const r = await fetchImpl(`${c.url}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: dbHeaders(c) });
    if (!r.ok && r.status !== 404) {
      log2(`[account] delete user HTTP ${r.status}`);
      throw new ApiError(500, "删除账号失败，请稍后再试");
    }
    userCache.clear();
    const store = subs.filter((x) => (x.source === "apple" || x.source === "google") && x.auto_renew && x.until && Date.parse(x.until) > now().getTime()).map((x) => x.source);
    log2(`[account] deleted ${user.id.slice(0, 8)}`);
    return { ok: true, cancelInStore: [...new Set(store)] };
  }
  async function checkout(c, request) {
    const user = await requireUser(c, request);
    if (!user.email) throw new ApiError(400, "账号没有邮箱");
    const body = await request.json().catch(() => ({}));
    const plan = body.plan;
    const period = body.period ?? "month";
    const price = priceOf(plan, period);
    if (price === null) throw new ApiError(400, "请选择套餐（T1 / T2）和付款周期（月付 / 年付）");
    const back = String(body.returnUrl || "");
    if (!/^https:\/\/[^\s]+$/.test(back) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(back)) throw new ApiError(400, "返回地址必须是 https 网址");
    const profile = await getProfile(c, user);
    const ent = entOf(c, user, profile);
    if (ent.plan === plan && profile.mp_status === "authorized" && ent.period === period) throw new ApiError(409, `你已经订阅了 ${PLANS[plan].name}`);
    const pa = await mp(c, "/preapproval", {
      method: "POST",
      body: JSON.stringify({
        reason: `账期助手 ${PLANS[plan].name}（${period === "year" ? "年付" : "月付"}）`,
        external_reference: `${user.id}|${plan}|${period}`,
        payer_email: user.email,
        back_url: back,
        status: "pending",
        auto_recurring: { frequency: period === "year" ? 12 : 1, frequency_type: "months", transaction_amount: price, currency_id: "BRL" }
      })
    });
    if (!pa.init_point) throw new ApiError(502, "Mercado Pago 没有返回付款链接");
    const patch = profile.mp_status === "authorized" ? { pending_id: pa.id, pending_plan: plan } : { mp_preapproval_id: pa.id, mp_status: pa.status ?? "pending", pending_plan: plan };
    await db(c, `zq_profiles?user_id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: now().toISOString() }) });
    return { url: pa.init_point };
  }
  async function cancel(c, request) {
    const user = await requireUser(c, request);
    const profile = await getProfile(c, user);
    if (!profile.mp_preapproval_id) throw new ApiError(400, "没有进行中的订阅");
    await mp(c, `/preapproval/${encodeURIComponent(profile.mp_preapproval_id)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
    const p = await refreshPreapproval(c, profile.mp_preapproval_id);
    return { status: p.mp_status, planUntil: p.plan_until ?? null };
  }
  async function reconcileSubscriptions(c) {
    if (!c.mpToken) return 0;
    const soon = new Date(now().getTime() + 5 * 864e5).toISOString();
    const rows = await db(c, `zq_profiles?select=user_id,mp_preapproval_id,pending_id,mp_status,plan_until&mp_preapproval_id=not.is.null`) ?? [];
    let n = 0;
    for (const r of rows) {
      const due = r.mp_status === "pending" || r.mp_status === "authorized" && (!r.plan_until || r.plan_until < soon);
      for (const id of [due ? r.mp_preapproval_id : null, r.pending_id].filter(Boolean)) {
        await refreshPreapproval(c, id).then(() => n++).catch(() => {
        });
      }
    }
    return n;
  }
  async function verifyMpSignature(c, request, dataId) {
    if (!c.mpWebhookSecret) return true;
    const sig = request.headers.get("x-signature") || "";
    const reqId = request.headers.get("x-request-id") || "";
    const parts = Object.fromEntries(sig.split(",").map((p) => p.trim().split("=").map((x) => x.trim())));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `${dataId ? `id:${String(dataId).toLowerCase()};` : ""}${reqId ? `request-id:${reqId};` : ""}ts:${parts.ts};`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(c.mpWebhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.length === parts.v1.length && hex === parts.v1.toLowerCase();
  }
  async function webhook(c, request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const type = String(body.type || body.topic || url.searchParams.get("type") || url.searchParams.get("topic") || "");
    const id = String(body.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
    if (!id) return { ignored: true };
    if (!await verifyMpSignature(c, request, url.searchParams.get("data.id") || id)) throw new ApiError(401, "invalid signature");
    if (/subscription_authorized_payment|authorized_payment/.test(type)) {
      const ap = await mp(c, `/authorized_payments/${encodeURIComponent(id)}`);
      if (ap?.preapproval_id) await refreshPreapproval(c, ap.preapproval_id);
      return { ok: true };
    }
    if (/preapproval/.test(type)) {
      await refreshPreapproval(c, id);
      return { ok: true };
    }
    if (type === "payment") return settlePayment(c, id);
    return { ignored: true };
  }
  async function rememberFnUrl(c, request) {
    const segs = new URL(request.url).pathname.split("/").filter(Boolean);
    const i = segs.indexOf("v1");
    const slug = segs[0] === "functions" && i >= 0 ? segs[i + 1] : segs[0];
    if (!slug || !c.url) return;
    const fnUrl = `${c.url}/functions/v1/${slug}`;
    if (await kvGet(c, "fn_url") !== fnUrl) await kvSet(c, "fn_url", fnUrl);
  }
  async function vapid(c) {
    const raw = await kvGet(c, "vapid");
    if (raw) return JSON.parse(raw);
    const keys = await generateVapidKeys();
    await db(c, "zq_kv", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ key: "vapid", value: JSON.stringify(keys) }) });
    return JSON.parse(await kvGet(c, "vapid") ?? JSON.stringify(keys));
  }
  async function subscribe(c, request) {
    const user = await requireUser(c, request);
    if (!entOf(c, user, await getProfile(c, user)).features.push) throw new ApiError(402, "关屏推送是 T1 / T2 套餐的功能", "plan_required");
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || "");
    const p256dh = String(b.keys?.p256dh || "");
    const auth = String(b.keys?.auth || "");
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1e3 || !p256dh || !auth) throw new ApiError(400, "推送订阅无效");
    await db(c, "zq_push_subs", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ endpoint, user_id: user.id, p256dh, auth, ua: String(request.headers.get("user-agent") || "").slice(0, 200), fails: 0 })
    });
    await rememberFnUrl(c, request).catch(() => {
    });
    return { ok: true };
  }
  async function unsubscribe(c, request) {
    const user = await requireUser(c, request);
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || "");
    await db(c, `zq_push_subs?user_id=eq.${user.id}${endpoint ? `&endpoint=eq.${encodeURIComponent(endpoint)}` : ""}`, { method: "DELETE" });
    return { ok: true };
  }
  async function sendToSubs(c, subs, payload) {
    const keys = await vapid(c);
    let sent = 0;
    for (const s of subs) {
      try {
        const r = await sendPush(s, payload, keys, { subject: c.pushSubject, fetchImpl });
        if (r.ok) {
          sent++;
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ last_ok: now().toISOString(), fails: 0 }) });
        } else if (r.gone || (s.fails ?? 0) >= 5) {
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
        } else {
          log2(`[push] HTTP ${r.status}`);
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ fails: (s.fails ?? 0) + 1 }) });
        }
      } catch (e) {
        log2(`[push] send failed ${e?.message ?? e}`);
      }
    }
    return sent;
  }
  async function pushTest(c, request) {
    const user = await requireUser(c, request);
    const subs = await db(c, `zq_push_subs?user_id=eq.${user.id}&select=*`);
    if (!subs?.length) throw new ApiError(400, "这台设备还没开启推送");
    const sent = await sendToSubs(c, subs, { title: "账期助手 · 测试推送", body: "关屏推送正常。每天圣保罗时间 09:00 左右提醒到期账单。", tag: "zq-test", url: "./#/bills" });
    return { sent, devices: subs.length };
  }
  function digest(bills, today) {
    const due = bills.filter((b) => !b.deletedAt && !String(b.id).startsWith("sample") && inReminderWindow(b, today));
    if (!due.length) return null;
    const overdue = due.filter((b) => billStatus(b, today) === "overdue");
    due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const total = due.reduce((s, b) => s + openCents(b), 0);
    const lines = due.slice(0, 4).map((b) => `${b.merchantNameSnapshot || "账单"} · ${isPartial(b) ? `还差 ${formatBRL(openCents(b))}` : formatBRL(b.totalCents)} · ${relativeDue(b.dueDate, today)}`);
    if (due.length > 4) lines.push(`…还有 ${due.length - 4} 笔`);
    return {
      title: overdue.length ? `${overdue.length} 笔已逾期 · 共 ${due.length} 笔要处理` : `付款提醒：${due.length} 笔，共 ${formatBRL(total)}`,
      body: lines.join("\n"),
      tag: `zq-digest-${today}`,
      url: "./#/bills/unpaid"
    };
  }
  async function cron(c, request) {
    const token = request.headers.get("x-cron-token") || "";
    const want = await kvGet(c, "cron_token");
    if (!want || token !== want) throw new ApiError(401, "bad cron token");
    const today = todayISO(now());
    const reconciled = await reconcileSubscriptions(c).catch(() => 0) + await reconcileStores(c).catch(() => 0);
    const subs = await db(c, "zq_push_subs?select=*") ?? [];
    const profiles = new Map((await db(c, "zq_profiles?select=*") ?? []).map((p) => [p.user_id, p]));
    const byUser = /* @__PURE__ */ new Map();
    subs.forEach((s) => byUser.set(s.user_id, [...byUser.get(s.user_id) ?? [], s]));
    let users = 0;
    let sent = 0;
    for (const [userId, list] of byUser) {
      const prof = profiles.get(userId);
      if (!entitlement(prof ?? null, { email: prof?.email ?? "", owners: c.owners, now: now() }).features.push) continue;
      const key = `${userId}|${today}`;
      const done = await db(c, `zq_push_log?key=eq.${encodeURIComponent(key)}&select=key`);
      if (done?.length) continue;
      const rows = await rpc(c, "zq_push_bills", { p_user: userId }) ?? [];
      const d = digest(rows.map((r) => ({ ...r.data, id: r.id })), today);
      if (!d) continue;
      users++;
      sent += await sendToSubs(c, list, d);
      await db(c, "zq_push_log", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ key }) });
    }
    log2(`[push] cron ${today} users=${users} sent=${sent} reconciled=${reconciled}`);
    return { users, sent };
  }
  async function route(request, env, sub, cors2) {
    const c = saasConfig(env);
    const json = (status, obj2) => new Response(JSON.stringify(obj2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors2 } });
    const handlers = {
      "GET /me": () => me(c, request),
      "POST /billing/checkout": () => checkout(c, request),
      "POST /billing/cancel": () => cancel(c, request),
      "POST /billing/webhook": () => webhook(c, request),
      "POST /billing/once": () => once(c, request),
      "POST /iap/verify": () => iapVerify(c, request),
      "POST /iap/apple": () => appleNotify(c, request),
      "POST /iap/google": () => googleNotify(c, request),
      "POST /account/delete": () => deleteAccount(c, request),
      "GET /push/key": async () => ({ publicKey: (await vapid(c)).publicKey }),
      "POST /push/subscribe": () => subscribe(c, request),
      "POST /push/unsubscribe": () => unsubscribe(c, request),
      "POST /push/test": () => pushTest(c, request),
      "POST /push/cron": () => cron(c, request)
    };
    const h = handlers[`${request.method} ${sub}`];
    if (!h) return null;
    try {
      return json(200, await h());
    } catch (e) {
      if (e instanceof StoreError) return json(e.status, { error: e.message, code: e.code });
      if (!(e instanceof ApiError)) log2(`[saas] ${sub} ${e?.stack ?? e}`);
      return json(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : "服务器内部错误", code: e?.code });
    }
  }
  async function health(request, env) {
    const c = saasConfig(env);
    let user = null;
    try {
      user = await getUser(c, request);
    } catch {
    }
    return { login: c.allowKeyOnly ? "optional" : "required", signedIn: !!user, billing: !!c.mpToken, stores: storesOn(c) };
  }
  return { route, authorizeRecognize, health, digest, verifyMpSignature, saasConfig };
}

// supabase/entry.mjs
var log = (m) => console.log(m);
var saas = createSaas({ log });
var handle = createHandler({ prompt: recognize_prompt_default, log, authorize: saas.authorizeRecognize, health: saas.health });
function projectKeys(get) {
  const keys = [];
  try {
    const j = JSON.parse(get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    for (const v of Object.values(j)) if (typeof v === "string" && v) keys.push(v);
  } catch {
  }
  const anon = get("SUPABASE_ANON_KEY");
  if (anon) keys.push(anon);
  return keys;
}
function supabaseEnv(all) {
  const get = (k) => all[k] || "";
  const keys = projectKeys(get);
  const token = [get("ACCESS_TOKEN"), ...keys].filter(Boolean).join(",");
  return { ...all, ACCESS_TOKEN: token, ALLOWED_ORIGINS: get("ALLOWED_ORIGINS") || "*" };
}
var ROUTES = ["/billing/checkout", "/billing/cancel", "/billing/webhook", "/billing/once", "/iap/verify", "/iap/apple", "/iap/google", "/account/delete", "/push/key", "/push/subscribe", "/push/unsubscribe", "/push/test", "/push/cron", "/me"];
function cors(req, env) {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim().replace(/\/$/, ""));
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin" };
}
async function serve(req, all) {
  const env = supabaseEnv(all);
  const u = new URL(req.url);
  const path = u.pathname.replace(/\/+$/, "");
  const sub = ROUTES.find((r) => path.endsWith(r));
  if (sub && req.method !== "OPTIONS") {
    const res = await saas.route(req, env, sub, cors(req, env));
    if (res) return res;
  }
  const inner = new Request(new URL(/\/health$/.test(path) ? "/api/health" : "/api/recognize", u.origin).href, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? void 0 : await req.text()
  });
  return await handle(inner, env) ?? new Response("not found", { status: 404 });
}
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve((req) => serve(req, Deno.env.toObject()));
}
export {
  projectKeys,
  serve,
  supabaseEnv
};
