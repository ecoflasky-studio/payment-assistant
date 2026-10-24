import { useState, type ReactNode } from 'react';
import { PLANS, TRIAL } from '../../shared/plans.mjs';
import { formatBRL } from '../lib/money';
import { useStore } from '../store';
import { ICamera, IList, IChart, IBell, IShield, IPhone, ICheck, IStore, IHelp } from '../ui/icons';
import { startTour } from '../ui/Tour';

const brl = (v: number) => formatBRL(Math.round(v * 100));

interface Section {
  id: string;
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    icon: <ICheck />,
    title: '三步上手',
    body: (
      <ol className="steps">
        <li>
          <b>拍照或上传</b>：点「新增」→「拍照识别」，拍订单、boleto、水电或税费单（也可以上传 PDF）。
        </li>
        <li>
          <b>核对一眼</b>：识别结果里标黄的字段需要你确认，其余自动填好；看不清的不会乱猜，会留空让你补。
        </li>
        <li>
          <b>等提醒</b>：保存后自动按账期算到期日，到期前在首页和通知里提醒你；付完点「标记已付」。
        </li>
      </ol>
    ),
  },
  {
    id: 'photo',
    icon: <ICamera />,
    title: '拍照识别技巧',
    body: (
      <ul className="steps">
        <li>单据铺平、四边都拍进去，光线均匀，别有手指或阴影挡住金额和日期。</li>
        <li>多页订单可以一次选多张图片，或直接上传 PDF。</li>
        <li>boleto 优先拍条码那一行（linha digitável），金额和到期日最准。</li>
        <li>手写单改过的数字，核对时会提示；你改过一次，同一商家下次会自动学会。</li>
        <li>上传前会先征得你同意；图片只用来识别，不会公开。</li>
      </ul>
    ),
  },
  {
    id: 'masters',
    icon: <IStore />,
    title: '商家与账期',
    body: (
      <ul className="steps">
        <li>在「设置 → 固定资料」里给商家设好默认账期（如 28 天、30/60/90 天分期），识别时自动套用。</li>
        <li>同一张订单可以拆成多期，每期单独提醒、单独标记已付。</li>
        <li>缴费单位（Sabesp、Enel、DAS 等）可设每月固定缴费日；账单设成「重复」后，付完自动生成下一期。</li>
      </ul>
    ),
  },
  {
    id: 'pay',
    icon: <IList />,
    title: '付款与对账',
    body: (
      <ul className="steps">
        <li>账单页按「未付 / 逾期 / 即将到期 / 已付」分组查看，可按商家、金额、单号搜索。</li>
        <li>付完点账单右侧的 ✓ 标记已付，点错了在提示条上点「撤销」；只付了一部分就到账单详情里「记一笔付款」。</li>
        <li>供应商的对账单拍一张，就能一次识别多笔账单批量导入。</li>
      </ul>
    ),
  },
  {
    id: 'remind',
    icon: <IBell />,
    title: '提醒与关屏推送',
    body: (
      <ul className="steps">
        <li>应用打开时会在首页和系统通知里提醒即将到期、已逾期的账单。</li>
        <li>
          订阅后可开「关屏推送」：手机锁屏也能每天收到到期摘要。iPhone 需要先「添加到主屏幕」再从主屏幕打开开启。
        </li>
        <li>账单页右上角可以导出日历（.ics），把到期日放进手机日历。</li>
      </ul>
    ),
  },
  {
    id: 'flow',
    icon: <IChart />,
    title: '流水与导出',
    body: (
      <ul className="steps">
        <li>「流水」按月汇总应付、已付、商家占比，左右切换月份。</li>
        <li>JSON 备份所有人都能用；CSV / Excel 导出属于 {PLANS.t2.name}。</li>
      </ul>
    ),
  },
  {
    id: 'secure',
    icon: <IShield />,
    title: '多设备与安全',
    body: (
      <ul className="steps">
        <li>用同一个邮箱在手机和电脑登录，账单自动同步；离线也能记账，联网后补传。</li>
        <li>登录一次，这台设备会被记住至少半年，不用反复输密码。</li>
        <li>
          手机上可以在「账号与套餐 → 这台设备」开启面容 ID / 指纹解锁：打开应用时验证本人，生物信息只留在手机里，不会上传。
        </li>
        <li>换手机或借给别人前，在账号页点「退出登录」。</li>
      </ul>
    ),
  },
  {
    id: 'install',
    icon: <IPhone />,
    title: '安装到主屏幕',
    body: (
      <ul className="steps">
        <li>
          <b>iPhone（Safari）</b>：点底部「分享」→「添加到主屏幕」→「添加」。
        </li>
        <li>
          <b>安卓（Chrome）</b>：点右上角「⋮」→「安装应用」或「添加到主屏幕」。
        </li>
        <li>
          <b>电脑（Chrome / Edge）</b>：地址栏右侧的安装图标 → 安装。
        </li>
        <li>装好后像普通 App 一样全屏打开，启动更快，也能收关屏推送。</li>
      </ul>
    ),
  },
  {
    id: 'plans',
    icon: <ICheck />,
    title: '套餐',
    body: (
      <ul className="steps">
        <li>
          新账号免费试用 {TRIAL.days} 天，含 {TRIAL.ai} 次 AI 识别，所有基础功能都能用。
        </li>
        <li>
          <b>{PLANS.t1.name}</b> {brl(PLANS.t1.month)}/月 或 {brl(PLANS.t1.year)}/年：关屏推送 + AI 识别 {PLANS.t1.ai} 次/月。
        </li>
        <li>
          <b>{PLANS.t2.name}</b> {brl(PLANS.t2.month)}/月 或 {brl(PLANS.t2.year)}/年：再加 CSV / Excel 导出 + AI 识别 {PLANS.t2.ai} 次/月。
        </li>
        <li>试用结束没订阅时，账单仍可查看和备份，但不能新增或修改。付款经 Mercado Pago，可随时取消自动续费。</li>
      </ul>
    ),
  },
  {
    id: 'faq',
    icon: <IHelp />,
    title: '常见问题',
    body: (
      <dl className="faq">
        <dt>识别错了怎么办？</dt>
        <dd>核对页直接改，保存即可。改过的写法会记在这个商家下，下次自动更正。</dd>
        <dt>AI 次数用完了？</dt>
        <dd>可以手动录入，或下个月额度自动恢复；识别失败不扣次数。</dd>
        <dt>没收到验证码邮件？</dt>
        <dd>看看垃圾邮件，或改用「密码登录」。</dd>
        <dt>数据会丢吗？</dt>
        <dd>登录后数据在云端也有一份；没登录时请定期在「数据管理」导出备份。</dd>
        <dt>为什么又要我登录？</dt>
        <dd>清除了浏览器数据、用了无痕模式，或在另一台设备点了「退出登录」，都需要重新登录一次。</dd>
      </dl>
    ),
  },
];

/** 教程正文：登录页弹窗和设置里的教程页共用 */
export function HelpContent({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState<string>('start');
  return (
    <div className="stack helpdoc">
      {SECTIONS.filter((s) => !compact || s.id !== 'faq').map((s, i) => (
        <details
          key={s.id}
          className="helpsec"
          open={open === s.id}
          style={{ animationDelay: `${i * 0.04}s` }}
          onToggle={(e) => {
            const el = e.currentTarget;
            if (el.open) setOpen(s.id);
            else if (open === s.id) setOpen('');
          }}
        >
          <summary>
            <span className="helpicon">{s.icon}</span>
            <b className="grow">{s.title}</b>
          </summary>
          <div className="helpbody small">{s.body}</div>
        </details>
      ))}
    </div>
  );
}

export function HelpPage() {
  const { go } = useStore();
  return (
    <>
      <section className="card stack">
        <h2>使用教程</h2>
        <p className="small muted">第一次用？从「三步上手」开始。也可以重新播放界面导览。</p>
        <div className="row">
          <button
            className="btn btn-primary"
            onClick={() => {
              go({ name: 'home' });
              setTimeout(startTour, 250);
            }}
          >
            重新播放导览
          </button>
          <button className="btn" onClick={() => go({ name: 'account' })}>
            账号与套餐
          </button>
        </div>
      </section>
      <section className="card">
        <HelpContent />
      </section>
    </>
  );
}
