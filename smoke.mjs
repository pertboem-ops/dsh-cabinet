/**
 * dsh-cabinet smoke：执行被验对象的纯函数与加载器，含负向用例
 * （构造不出 FAIL 用例的检查不得宣称存在）。Node 单文件、无依赖：
 *   node smoke.mjs
 */
import {
  TIERS,
  MINISTER_NAMES,
  modelFamily,
  checkSeatDimensions,
  stripFrontmatter,
  parseFrontmatterMeta,
  loadMinisters,
  loadSkills,
  normalizePinning,
  normalizePool,
  buildInstruction,
} from "./lib/index.js";

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// modelFamily
check("modelFamily 斜杠形式", modelFamily("kimi-coding/k3") === "kimi-coding");
check("modelFamily 裸 provider", modelFamily("zai-coding-cn") === "zai-coding-cn");
check("modelFamily 空值", modelFamily("") === "" && modelFamily(undefined) === "");

// checkSeatDimensions 正向
const okSeats = [
  { seat: "红队批判官", temperament: "攻击", stance: "共识是错的", model: "kimi-coding", isRedTeam: true },
  { seat: "正方", temperament: "辩护", stance: "建设", model: "zai-coding-cn" },
  { seat: "信源核查官", temperament: "核查", stance: "信源分级", model: "deepseek-account" },
  { seat: "方法审查官", temperament: "审查", stance: "程序正义", model: "deepseek-account" },
];
check("三维不重合·正向通过", checkSeatDimensions(okSeats, "zai-coding-cn").pass === true);

// 负向：气质全同
const sameTemp = okSeats.map((s) => ({ ...s, temperament: "同质" }));
const r1 = checkSeatDimensions(sameTemp, "zai-coding-cn");
check("三维不重合·气质全同 FAIL", !r1.pass && r1.failures.some((f) => f.includes("气质维")));
// 负向：立场全同
const sameStance = okSeats.map((s) => ({ ...s, stance: "同一锚点" }));
const r2 = checkSeatDimensions(sameStance, "zai-coding-cn");
check("三维不重合·立场全同 FAIL", !r2.pass && r2.failures.some((f) => f.includes("立场维")));
// 负向：模型单源
const sameModel = okSeats.map((s) => ({ ...s, model: "zai-coding-cn" }));
const r3 = checkSeatDimensions(sameModel, "kimi-coding");
check("三维不重合·模型单源 FAIL", !r3.pass && r3.failures.some((f) => f.includes("模型维")));
// 负向：红队与会话同源
const r4 = checkSeatDimensions(okSeats, "kimi-coding");
check("三维不重合·红队同源 FAIL", !r4.pass && r4.failures.some((f) => f.includes("红队")));
// 负向：会话模型未知（P3 失败关闭——空对照物不得静默放行）
const r5 = checkSeatDimensions(okSeats, "");
check("三维不重合·空会话模型 FAIL（失败关闭）", !r5.pass && r5.failures.some((f) => f.includes("不可判定")));
// 无红队席时 sessionModel 缺失不触发该条（其他维度照常）
const noRed = okSeats.filter((s) => !s.isRedTeam);
check("三维不重合·无红队不受失败关闭影响", checkSeatDimensions(noRed, "").pass === true);
// 负向：空名单
check("三维不重合·空名单 FAIL", checkSeatDimensions([], "x").pass === false);

// stripFrontmatter / parseFrontmatterMeta
const sample = "---\nname: x\ndescription: y\n---\n\n正文第一行\n第二行\n";
check("stripFrontmatter 剥头", stripFrontmatter(sample).startsWith("正文第一行"));
check("parseFrontmatterMeta 取值", parseFrontmatterMeta(sample)?.name === "x");
const crlf = "---\r\nname: x\r\n---\r\n正文\r\n";
check("stripFrontmatter CRLF", stripFrontmatter(crlf).includes("正文"));

// loadMinisters：八席齐备、人格非空、frontmatter 已剥
const ministers = loadMinisters();
check("阁员八席齐备", ministers.length === 8, `实得 ${ministers.length}`);
check(
  "阁员键覆盖 MINISTER_NAMES",
  Object.keys(MINISTER_NAMES).every((k) => ministers.some((m) => m.key === k)),
);
check(
  "阁员人格无 frontmatter 残留且非空",
  ministers.every((m) => m.persona.length > 50 && !m.persona.startsWith("---") && !/^name:/m.test(m.persona.slice(0, 200))),
);

// loadSkills：四技能、name 合法、description 非空
const skills = loadSkills();
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
check("技能四件齐备", skills.length === 4, `实得 ${skills.length}`);
check(
  "技能 name 全部合法",
  skills.every((s) => SKILL_NAME.test(s.name)),
  skills.map((s) => s.name).join(","),
);
check(
  "技能 description 非空且正文无 frontmatter",
  skills.every((s) => s.description.length > 0 && !s.content.startsWith("---")),
);
check(
  "技能名集合正确",
  ["cabinet", "cabinet-roles-coding", "cabinet-roles-writing", "cabinet-roles-research"].every((n) =>
    skills.some((s) => s.name === n),
  ),
);

// normalizePinning
const pin = normalizePinning({
  feng: { provider: "kimi-coding", model: "k3", reasoningEffort: "high" },
  ju: { provider: "deepseek-account", model: "deepseek-flash" },
  bad: { provider: "x", model: "y" }, // 非阁员键，剔除
  li: { provider: "", model: "glm-5.3" }, // 缺 provider，剔除
});
check("钉扎规范化保留合法项", pin.feng?.provider === "kimi-coding" && pin.ju?.model === "deepseek-flash");
check("钉扎规范化剔除非法项", pin.bad === undefined && pin.li === undefined);
check("钉扎规范化容忍空 config", Object.keys(normalizePinning(undefined)).length === 0);

// normalizePool：候选池（征召席与回退场景可选路由；不改动阁员钉扎）
const pool = normalizePool([
  { provider: "qwen-token-plan-cn", model: "qwen3.8-max", reasoningEffort: "high" },
  { provider: "qwen-token-plan-cn", model: "qwen3.8-flash" }, // 缺 reasoningEffort = 继承默认
  { provider: "", model: "bad" }, // 缺 provider，剔除
  "garbage", // 非对象，剔除
]);
check("候选池保留合法项且保序", pool.length === 2 && pool[0].provider === "qwen-token-plan-cn" && pool[1].model === "qwen3.8-flash");
check("候选池 reasoningEffort 可选", pool[0].reasoningEffort === "high" && pool[1].reasoningEffort === undefined);
check("候选池容忍非数组", normalizePool(undefined).length === 0 && normalizePool("x").length === 0);

// buildInstruction：standard 档
const plan = buildInstruction({
  topic: "该不该把 monorepo 拆成多仓库？",
  scene: "coding",
  tier: undefined,
  goal: "一份可执行的迁移方案",
  ministers,
  pinning: pin,
});
check("计划含议题原文", plan.includes("该不该把 monorepo 拆成多仓库？"));
check("计划含目标行", plan.includes("一份可执行的迁移方案"));
check("计划含角色包名", plan.includes("cabinet-roles-coding"));
check("计划含 standard 预算", plan.includes("9 次子智能体委派"));
check("计划含红队固定席", plan.includes("红队批判官"));
check("计划含映射表", plan.includes("正方") && plan.includes("方法审查官"));
check("计划含钉扎表", plan.includes("kimi-coding") && plan.includes("deepseek-account"));
check("计划内嵌阁员人格", ministers.every((m) => plan.includes(m.persona.trim().slice(0, 20))));
check("standard 档无二轮质询步骤", !plan.includes("交叉质询（全新委派"));
check("standard 档含升档指引", plan.includes("升档到进阶"));
check("计划含议定书 schema", plan.includes('"schemaVersion": 2'));
check("计划含归档目录", plan.includes(".cabinet/<时间戳>-<slug>"));
check("计划含 R1 后必停", plan.includes("必须停下等用户"));
// P3：红队铁律执法文本在册
check("计划含红队回退例外", plan.includes("回退只许改落另一钉扎 provider 家族") && plan.includes("响亮中止组阁"));
check("计划含会话模型失败关闭", plan.includes("无法确定会话模型时不得放行"));
check("计划含失配披露写入简报", plan.includes("失配披露写入简报"));

// buildInstruction：advanced 档
const plan2 = buildInstruction({ topic: "t", scene: "research", tier: "advanced", ministers, pinning: pin });
check("advanced 档含二轮质询", plan2.includes("交叉质询（全新委派"));
check("advanced 档预算 16 次", plan2.includes("16 次子智能体委派"));
check("advanced 档角色包 research", plan2.includes("cabinet-roles-research"));

// buildInstruction：非法 scene/tier 回退
const plan3 = buildInstruction({ topic: "t", scene: "nope", tier: "nope", ministers, pinning: pin });
check("非法 scene 回退 general", plan3.includes("cabinet-roles-research"));
check("非法 tier 回退 standard", plan3.includes("= 4 席 × 1 轮"));

// buildInstruction：空钉扎时全部走征召的提示存在
const plan4 = buildInstruction({ topic: "t", ministers, pinning: {} });
check("空钉扎走征召提示", plan4.includes("未钉扎：该阁员席位走征召"));

// buildInstruction：候选池在册时计划内嵌池表，且征召/回退文本引用池
const poolPlan = buildInstruction({ topic: "t", ministers, pinning: pin, pool });
check("计划含候选池表", poolPlan.includes("候选池") && poolPlan.includes("qwen-token-plan-cn") && poolPlan.includes("qwen3.8-max"));
check("征召席按序取用候选池", poolPlan.includes("模型从候选池按序取用"));
check("回退引用候选池", poolPlan.includes("回退候选池下一可用路由") && poolPlan.includes("从钉扎表或候选池中"));
check("红队异源回退文本仍在册", poolPlan.includes("回退只许改落另一钉扎 provider 家族") && poolPlan.includes("响亮中止组阁"));
// 候选池缺省（未配置）时计划不出现池表，行为与旧版一致
check("无候选池时不渲染池表", !plan4.includes("候选池（征召席与回退场景"));

// 故障注入（v0.2.2 §四.4）：钉扎全不可用/空 sessionModel 两类静默故障场景下
// 计划文本仍须含响亮中止路径
check("故障注入·钉扎全空仍含红队响亮中止", plan4.includes("响亮中止组阁"));
check("故障注入·空 sessionModel 判据失败关闭", checkSeatDimensions(okSeats, "").pass === false);

// 双形态（v0.2.2 参数化分支）
import { CONTINUATION_ENABLED, MECHANISMS } from "./lib/index.js";
check("CONTINUATION_ENABLED 默认 false", CONTINUATION_ENABLED === false);
check("MECHANISMS 在册两机制", MECHANISMS.includes("A-card") && MECHANISMS.includes("C-overview"));
const planCold = buildInstruction({ topic: "t", tier: "advanced", ministers, pinning: pin, continuation: false });
const planCont = buildInstruction({ topic: "t", tier: "advanced", ministers, pinning: pin, continuation: true });
check("冷启动形态无二轮续谈指令", planCold.includes("不要使用续谈") && !planCold.includes("续谈优先"));
check(
  "续谈形态关键要素齐备",
  planCont.includes("续谈优先") && planCont.includes("冷启动兜底") && planCont.includes("升档即冷启动") &&
    planCont.includes("TTL") && planCont.includes("保留各席的委派 id"),
);
check("续谈形态 replayable=false 披露", planCont.includes('"replayable": false'));
check("冷启动形态 replayable=true 披露", planCold.includes('"replayable": true'));
check("双形态均含 dispatch 前缀约定", planCold.includes("dispatch:spawn") && planCont.includes("dispatch:send_message"));

// v0.2.5/v0.2.6 机制（披露卡提问式停等 + 两栏速览 + 误拦恢复 + 占位）
check("披露卡为提问式停等（v0.2.6）", planCold.includes("ask_user_question") && planCold.includes("确认开议") && !planCold.includes("照出即继续"));
check("披露卡在 R1 派发之前", planCold.indexOf("组阁披露") < planCold.indexOf("第 1 步"));
check("两栏速览齐备", planCold.includes("共识面") && planCold.includes("分歧面") && planCold.includes("枚举支持席位名单"));
check("误拦恢复通道在册", planCold.includes("误拦恢复") && planCold.includes("gate_overrides"));
check("beyond_preanswer 占位且禁回填", planCold.includes('"beyond_preanswer": { "count": null, "items": [] }') && planCold.includes("禁止回填"));
check("机制集日落可拆（mechanisms=[]）", (() => {
  const bare = buildInstruction({ topic: "t", tier: "advanced", ministers, pinning: pin, mechanisms: [] });
  return !bare.includes("第 0.5 步") && !bare.includes("ask_user_question") && !bare.includes("共识面") && bare.includes("（无）");
})());

console.log(`结果：${pass + fail} 项检查，${fail} 项失败`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
