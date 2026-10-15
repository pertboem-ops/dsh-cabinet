/**
 * dsh-cabinet · Cabinet 内阁议事的 dsh 移植（v0.2.6）。
 *
 * 注册一个编排计划生成器工具 cabinet_start 与四个技能（cabinet 主技能 +
 * 三场景角色包）。插件不自己派发子智能体，只返回完整议事编排计划，由
 * 父智能体用 subagent / send_message / list_agents 执行。
 *
 * 移植自 PI-Desktop 插件 cabinet 0.3.0（main.js + skills/）。dsh 适配要点：
 * - PI 的"委派目录专职子智能体"在 dsh 不存在 → 阁员 = 人格文本（ministers/
 *   内嵌进计划）+ 模型钉扎（cordis.patch.yml config.ministers），委派时以
 *   subagent 的 provider/model/reasoning_effort 参数下发；
 * - PI 的 Task/TaskWait/TaskList → subagent(run_in_background) + 完成通知 /
 *   list_agents（v0.1.2：删 wait_agent 残留——standard preset 工具面无此
 *   工具，asar 源码核验）；
 * - v0.2.2：续谈形态参数化分支（CONTINUATION_ENABLED 代码常量，默认 false，
 *   翻转规则与消亡条款见 docs/设计方案-v0.2.2.md §五）；events 收窄为最小集
 *   + dispatch:spawn/dispatch:send_message 前缀约定（审计器对账锚点）；
 *   protocol 增 replayable 字段；
 * - v0.2.5：组阁披露卡（第 0.5 步，照出即继续不停等）+ 两栏速览（共识面/
 *   分歧面）+ 误拦恢复通道（gate_overrides 分列）+ beyond_preanswer 占位
 *   （恒 null 禁回填）+ render-context 机制集（MECHANISMS，日落即删键）；
 * - 无沙箱权限清单：host 代码进程内执行，读包内文件不受限。
 *
 * M1′ 约束沿用：本文件的议事计划生成只做纯字符串模板与纯函数；文件读取
 * 仅发生在插件加载时（技能正文、阁员人格），运行期无 I/O、无状态。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(PACKAGE_DIR);

// 双轨预算（唯一真源 = config/tiers.json；本字面量块与其逐字段一致，
// verify.mjs 机检——改数值只改 tiers.json 后同步本块与技能内的表）。
// 调用轨 = 执法轨（硬顶）：cap = 名义 + 一整轮重派 + 1。
// token 轨 = 参考轨（软指标）：标称×1.1 + 次均成本，四舍五入至千位。
// >>> TIERS — 与 config/tiers.json 逐字段一致 — DO NOT EDIT（改 tiers.json）
const TIERS = {
  standard: {
    seats: 4,
    rounds: 1,
    nominalTokens: 14000,
    tokenCap: 19000,
    callCap: 9, // 名义 4 + 一整轮重派 4 + 1
    nominal: "4 次",
    estimate: "约 14K token / 4 次调用 / 约 60 秒",
  },
  advanced: {
    seats: 5,
    rounds: 2,
    nominalTokens: 45000,
    tokenCap: 54000,
    callCap: 16, // 名义 10（5席×2轮）+ 一整轮重派 5 + 1
    nominal: "10 次",
    estimate: "约 45K token / 10 次调用 / 约 80-90 秒",
  },
  max: {
    seats: 6,
    rounds: 2,
    nominalTokens: 55000,
    tokenCap: 65000,
    callCap: 19, // 名义 12（6席×2轮）+ 一整轮重派 6 + 1
    nominal: "12 次",
    estimate: "约 55K token / 12 次调用 / 约 2 分钟",
  },
};
// <<< TIERS

const SCENE_ROLE_PACKS = {
  coding: "cabinet-roles-coding",
  writing: "cabinet-roles-writing",
  research: "cabinet-roles-research",
  general: "cabinet-roles-research",
};

// 阁员中文名（计划与披露用；八席，与 ministers/ 文件名一致）
const MINISTER_NAMES = {
  feng: "锋（红队攻击手）",
  ju: "据（证据官）",
  li: "立（辩护人）",
  mou: "谋（落地官）",
  yuan: "远（长期席）",
  zhong: "众（读者代理）",
  shen: "审（方法检察官）",
  gu: "骨（结构师）",
};

// 席位 → 首选专职阁员映射表（移植自 ministers/README v0.5 席位覆盖）
const SEAT_MAPPING = [
  ["红队批判官（固定席）", "锋", "异源铁律；任何议题不可缺席"],
  ["反方", "征召", "锋被红队固定席占用；红队走征召时反方可取锋"],
  ["架构官 / 立意官", "远", ""],
  ["工程官", "谋", ""],
  ["成本官 / 读者代理", "众", ""],
  ["信源核查官 / 事实核查官", "据", ""],
  ["正方", "立", ""],
  ["方法审查官", "审", ""],
  ["结构官", "骨", ""],
];

function resolveTier(tier) {
  return TIERS[tier] || TIERS.standard;
}

// —— §16.4 三维不重合检查（纯函数；smoke 注入负向用例）——
// dsh 模型家族口径 = 委派路由的 provider 字段；兼容 "provider/model" 写法。
function modelFamily(model) {
  const s = typeof model === "string" ? model.trim() : "";
  return s.includes("/") ? s.split("/")[0] : s;
}

/**
 * 三维不重合检查（组阁后必做）。纯函数、无 I/O。
 * @param {Array<{seat:string, temperament?:string, stance?:string, model:string, isRedTeam?:boolean}>} seats
 * @param {string} sessionModel 会话当前模型路由（红队异源铁律的对照物）
 * @returns {{pass:boolean, failures:string[]}}
 */
function checkSeatDimensions(seats, sessionModel) {
  if (!Array.isArray(seats) || seats.length === 0) {
    return { pass: false, failures: ["组阁名单为空或非法"] };
  }
  const failures = [];
  const uniqCount = (key) =>
    new Set(seats.map((s) => s?.[key]).filter((v) => v !== undefined && v !== null && v !== "")).size;
  if (seats.length > 1 && uniqCount("temperament") < 2) {
    failures.push("气质维全重合：在场专职席气质全部相同");
  }
  if (seats.length > 1 && uniqCount("stance") < 2) {
    failures.push("立场维全重合：角色卡锚点全部相同");
  }
  const families = new Set(seats.map((s) => modelFamily(s?.model)).filter(Boolean));
  if (families.size < 2) {
    failures.push("模型维全重合：各席实际派发路由 <2 个 provider 家族");
  }
  const red = seats.find((s) => s?.isRedTeam);
  if (red) {
    if (!sessionModel) {
      // 失败关闭（P3，2026-10-09 首场审议 D5）：会话模型未知时红队异源不可判定，
      // 不得静默放行——中止组阁。
      failures.push("红队异源不可判定：会话模型未知——中止组阁，不得静默放行");
    } else if (modelFamily(red.model) === modelFamily(sessionModel)) {
      failures.push("红队异源铁律被违反：红队批判官与会话模型同源");
    }
  }
  return { pass: failures.length === 0, failures };
}

// —— 包内资源加载（仅插件加载时执行一次；运行期无 I/O）——

/** 剥去 md 首块 frontmatter，返回正文（CRLF/LF 均可）。 */
function stripFrontmatter(raw) {
  const text = String(raw);
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0].trimEnd() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
  }
  return text;
}

/** 读取 md 首块 frontmatter 的 name/description（行级解析，不做完整 YAML）。 */
function parseFrontmatterMeta(raw) {
  const text = String(raw);
  if (!text.startsWith("---")) return null;
  const lines = text.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") { end = i; break; }
  }
  if (end < 0) return null;
  const out = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/);
    if (m && out[m[1]] === undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * 加载八阁员人格文本。frontmatter 整体剥去（dsh 不消费其中的
 * model/thinkingLevel/tools——钉扎由 config 供给）；人格正文逐字保留。
 * @returns {Array<{key:string, name:string, persona:string}>}
 */
function loadMinisters() {
  const dir = join(PACKAGE_ROOT, "ministers");
  return readdirSync(dir)
    .filter((f) => /^cabinet-[a-z]+\.md$/.test(f))
    .sort()
    .map((f) => {
      const key = f.replace(/^cabinet-/, "").replace(/\.md$/, "");
      const raw = readFileSync(join(dir, f), "utf8");
      return { key, name: MINISTER_NAMES[key] || key, persona: stripFrontmatter(raw) };
    });
}

/** 加载四个技能文件，返回 [{name, description, content}]。 */
function loadSkills() {
  const files = [
    join(PACKAGE_ROOT, "skills", "cabinet.md"),
    join(PACKAGE_ROOT, "skills", "roles", "coding.md"),
    join(PACKAGE_ROOT, "skills", "roles", "writing.md"),
    join(PACKAGE_ROOT, "skills", "roles", "research.md"),
  ];
  return files.map((path) => {
    const raw = readFileSync(path, "utf8");
    const meta = parseFrontmatterMeta(raw);
    if (!meta?.name || !meta?.description) {
      throw new Error(`dsh-cabinet: 技能文件缺 frontmatter name/description: ${path}`);
    }
    return { name: meta.name, description: meta.description, content: stripFrontmatter(raw) };
  });
}

/** 规范化钉扎表：{ feng: {provider, model, reasoningEffort?}, ... }，非法项剔除。 */
function normalizePinning(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(MINISTER_NAMES)) {
      const v = raw[key];
      if (v && typeof v.provider === "string" && typeof v.model === "string" && v.provider && v.model) {
        out[key] = {
          provider: v.provider,
          model: v.model,
          ...(typeof v.reasoningEffort === "string" && v.reasoningEffort
            ? { reasoningEffort: v.reasoningEffort }
            : {}),
        };
      }
    }
  }
  return out;
}

/** 规范化候选池：[{provider, model, reasoningEffort?}]，非法项剔除、保持声明顺序。 */
function normalizePool(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v) => v && typeof v.provider === "string" && typeof v.model === "string" && v.provider && v.model,
    )
    .map((v) => ({
      provider: v.provider,
      model: v.model,
      ...(typeof v.reasoningEffort === "string" && v.reasoningEffort
        ? { reasoningEffort: v.reasoningEffort }
        : {}),
    }));
}

function renderPoolTable(pool) {
  if (!pool || pool.length === 0) return "";
  const lines = [
    `   - **候选池**（征召席与回退场景按序取用，不改动阁员钉扎；池空才会话默认模型）：`,
    ``,
    `     | 序 | provider | model | reasoningEffort |`,
    `     |--|----------|-------|-----------------|`,
  ];
  pool.forEach((p, i) =>
    lines.push(`     | ${i + 1} | ${p.provider} | ${p.model} | ${p.reasoningEffort ?? "（继承模型默认）"} |`),
  );
  return lines.join("\n");
}

function renderPinningTable(pinning) {
  const lines = [
    `| 阁员 | provider | model | reasoningEffort |`,
    `|------|----------|-------|-----------------|`,
  ];
  for (const key of Object.keys(MINISTER_NAMES)) {
    const p = pinning[key];
    lines.push(
      p
        ? `| ${MINISTER_NAMES[key]} | ${p.provider} | ${p.model} | ${p.reasoningEffort ?? "（继承模型默认）"} |`
        : `| ${MINISTER_NAMES[key]} | — | — | 未钉扎：该阁员席位走征召（仅角色卡、会话默认模型） |`,
    );
  }
  return lines.join("\n");
}

function renderMappingTable() {
  return [
    `| 角色包席位 | 映射阁员 | 备注 |`,
    `|-----------|---------|------|`,
    ...SEAT_MAPPING.map(([seat, minister, note]) => `| ${seat} | ${minister} | ${note} |`),
  ].join("\n");
}

function renderPersonas(ministers) {
  return ministers
    .map((m) => [`### 阁员·${m.name}（键 ${m.key}）`, ``, m.persona.trimEnd()].join("\n"))
    .join("\n\n");
}

// —— v0.2.2 续谈开关（P6：代码常量承载，默认 false，实证翻转规则与消亡条款
// 见 docs/设计方案-v0.2.2.md §五）。false=冷启动（全新委派+内嵌原文）；
// true=R2/点名追问优先 send_message 续谈存活席位，失败退回冷启动。
// 翻转条件：G1+G2+G5 全过且 n≥3 场续谈实跑无退化；v0.3 前必须二择一。
const CONTINUATION_ENABLED = false;

// —— v0.2.5 已实建机制集（render-context 能力对象，P7：日落条款动作 =
// 从本表删键）。A-card=组阁披露卡（默认继续）；C-overview=共识/分歧两栏速览。
const MECHANISMS = ["A-card", "C-overview"];

/**
 * 生成议事编排计划。计划是自包含的：父智能体读完后不再需要本插件的
 * 任何其他输入即可执行全场议事（阁员人格与钉扎表已内嵌）。
 * @param {object} args
 * @param {boolean} args.continuation 续谈形态（由 CONTINUATION_ENABLED 供给）
 * @param {string[]} args.mechanisms 已实建机制集（由 MECHANISMS 供给；日落即删键）
 */
function buildInstruction({ topic, scene, roles, tier, goal, ministers, pinning, pool = [], continuation = false, mechanisms = MECHANISMS }) {
  const t = resolveTier(tier);
  const sceneKey = SCENE_ROLE_PACKS[scene] ? scene : "general";
  const rolePackId = SCENE_ROLE_PACKS[sceneKey];
  const customRoles = Array.isArray(roles) && roles.length > 0 ? roles : null;
  const hasCard = mechanisms.includes("A-card");
  const hasOverview = mechanisms.includes("C-overview");
  const goalLine = goal
    ? `本场议事必须产出：${goal}`
    : "本场议事应收敛为一份明确、可执行的结论；无法收敛时如实记录分歧状态，不强行凑共识。";

  return [
    `## 内阁议事编排计划`,
    ``,
    `**议题：** ${topic}`,
    `**场景：** ${sceneKey}（角色包技能名：${rolePackId}）`,
    `**档位：** ${tier || "standard"} = ${t.seats} 席 × ${t.rounds} 轮`,
    `**续谈模式：** ${continuation ? "开（R2/点名追问优先 send_message 存活席位，失败退回冷启动）" : "关（冷启动：R2/点名追问一律全新委派 + 简报内嵌原文）"}`,
    `**机制集：** ${mechanisms.length > 0 ? mechanisms.join("、") : "（无）"}（组阁披露卡/两栏速览等可日落机制的在册状态）`,
    `**预算：** 调用轨（执法轨，触顶即中止）${t.callCap} 次子智能体委派（= 名义 ${t.nominal} + 一整轮重派 + 1）；`,
    `token 轨（参考轨，软指标，入账不中止）${t.tokenCap}（= 标称 ${t.nominalTokens / 1000}K ×1.1 + 次均成本，四舍五入至千位）。`,
    `**记账口径：** 只计子智能体委派（spawn 与 send_message 同计一次）与子智能体 token；主持人自身回合、cabinet_start 调用不计。`,
    goalLine,
    ``,
    `严格按以下步骤执行。阁员之间不直接通信，你是唯一的集成点。`,
    ``,
    `### 第 0 步 — 前置检查（必须先做，缺一不可）`,
    ``,
    `1. **模式检查**：若当前处于 Plan 模式（工具调用受限），停止并告知用户`,
    `   "内阁议事需要完整工具权限，请退出 Plan 模式后重试"。`,
    `2. **加载角色包**：用 skill 工具加载技能 ${rolePackId}，取得本场席位定义。`,
    customRoles
      ? `   用户指定了席位：${customRoles.map((r) => `"${r}"`).join(", ")}。用指定席位覆盖角色包默认席位，但**红队批判官必须保留**。`
      : `   按角色包默认席位组阁，共 ${t.seats} 席（含固定席：红队批判官）。`,
    `3. **席位映射（两级：首选专职阁员 → 征召）**：`,
    `   - 按下表把席位映射到阁员（阁员 = 下文内嵌的人格文本 + 钉扎表模型路由）：`,
    ``,
    renderMappingTable(),
    ``,
    `   - **同一阁员同场不兼任两席**——被占用或未钉扎的席位走征召：仅角色卡，`,
    `     模型从候选池按序取用（池空才会话默认模型派发，零配置回退），`,
    `     disclosure 注明。`,
    `   - 各阁员的派发路由（钉扎表，源自插件 config）：`,
    ``,
    renderPinningTable(pinning),
    ...(pool.length > 0 ? [``, renderPoolTable(pool)] : []),
    ``,
    `   - **路由核对**：派发前用 list_subagent_models 逐一核对钉扎表与候选池`,
    `     路由在本机可用`,
    `     （provider 存在且 model 在目录内）。不可用或 subagent 工具拒绝`,
    `     provider/model 参数（模型选择未在 Settings → 子智能体启用）时，该席`,
    `     回退候选池下一可用路由（池空才会话默认模型）派发，并在议定书`,
    `     disclosure 注明失配——**红队批判官`,
    `     例外**：红队回退只许改落另一钉扎 provider 家族（从钉扎表或候选池中`,
    `     择一异源路由，disclosure 注明改钉）；两个家族皆不可用则**响亮中止组阁**`,
    `     并向用户说明，不得静默降级为同源。`,
    `   - **失配披露写入简报**：任何席位"钉扎路由 vs 实际派发路由"不一致的，`,
    `     除开场披露与 protocol.disclosure 外，还须把失配事实写进该席简报开头`,
    `     （阁员须知自己在以非钉扎模型出场）。`,
    `4. **三维不重合检查（组阁后必做；判据＝本插件导出的 checkSeatDimensions 纯函数，可测）**：`,
    `   气质维（在场阁员人格气质不全同）、立场维（角色卡锚点不全同）、模型维`,
    `  （各席实际派发路由 ≥2 个 provider 家族，红队异源）。某维全重合 → 至少换`,
    `   一席（改征召或换阁员），并在 events.jsonl 记录换席原因。`,
    `   - **先确定会话模型**：红队异源判定的对照物是你自己的模型路由（你的系统`,
    `     提示词/模型选择中载明）。**无法确定会话模型时不得放行——中止组阁并向`,
    `     用户说明**（判据失败关闭：空对照物 = 检查不通过，不静默跳过）。`,
    `   - **误拦恢复通道**：若用户确信失败关闭系误报（如宿主模型自报信息错误），`,
    `     用户可显式说"误拦恢复：按 X 继续"；放行时 disclosure 大写标注`,
    `     "三维失败/红队同源系用户显式误拦恢复"，并在 index.jsonl 的`,
    `     gate_overrides 列计数（与 gate_blocks 分列：拦截止 gate_blocks、放行`,
    `     入 gate_overrides——越稀有的越不能混账）。`,
    `   - **开场披露必含一行**：逐席"钉扎路由 vs 实际派发路由"对照——有失配即`,
    `     记入 protocol.disclosure；只列打算用的模型清单不算 diff。`,
    `5. **开场披露**：向用户输出一行说明——"本场议事阁员为 AI 分角色推演，价值`,
    `   在强制多视角，不代表独立专家意见。"`,
    ``,
    ...(hasCard
      ? [
          `### 第 0.5 步 — 组阁披露与确认（**停等用户**，v0.2.6 用户裁决恢复停等）`,
          ``,
          `组阁完成后向用户输出下卡，然后用 ask_user_question 提问，**停下等用户`,
          `答复**——未获显式"确认开议"不得派发任何席位（此为本场第一个强制`,
          `停等点；v0.2.5 审议曾裁定"不停等"，2026-10-13 用户显式裁决恢复停等，`,
          `反对意见存档于 docs/设计方案-v0.2.5.md）。`,
          ``,
          `\`\`\``,
          `## 组阁披露`,
          ``,
          `议题：… ｜ 档位：… ｜ 续谈模式：…`,
          ``,
          `| 席位 | 阁员 | provider | model | 思考强度 | 钉扎=实际？ |`,
          `|------|------|----------|-------|---------|------------|`,
          `| （逐席六列，取第 0 步已算结果） |`,
          ``,
          `三维检查：气质/立场/模型三维结果 + 红队异源结论（vs 会话模型）`,
          `失配披露：（无 / 逐席列出并注明已写入该席简报）`,
          `守护半径：本卡只披露软失配；硬闸（红队异源/三维失败关闭）已在派发前`,
          `拦截，不在本卡重复裁决。`,
          `\`\`\``,
          ``,
          `随后调用 ask_user_question：question="组阁方案如上，是否开议？"，options：`,
          `1. "确认开议"——按上表派发 R1；2. "改定席位模型"——用户在答复中写明`,
          `改定（如"锋换 zai-coding-cn/glm-5.3 high"）；3. "散会"——终止。`,
          ``,
          `**答复处理规程**：`,
          `- 确认开议 → 进第 1 步。`,
          `- 改定 → 逐条落回组阁表，重跑路由核对与三维检查（含红队异源失败关闭），`,
          `  输出改定后新卡并**再次提问确认**——改定不直接触发派发；不合规的改定`,
          `  说明原因并留在确认环节。`,
          `- 散会 → 输出简版议定书并终止（cost.calls=0 如实记账）。`,
          ``,
          `**守护半径**：卡只保软失配披露（钉扎配置病的可见性）；软失配的正解是`,
          `用户改 cordis.patch.yml 钉扎（修一次永久消除），卡承担"让用户看见并`,
          `拦截"双重职责。events.jsonl 记"组阁披露卡呈现"（setup）与用户答复`,
          `（steering）；index.jsonl 的 card_reactions 列记 确认/改定/散会。`,
          ``,
        ]
      : []),
    `### 第 1 步 — 第一轮：独立立场书（并发派发 ${t.seats} 个 subagent）`,
    ``,
    `每个 subagent 委派（run_in_background: true 并发派发，随后以完成通知`,
    `收齐）的 prompt 必须包含：`,
    ...(continuation
      ? [
          `- **保留各席的委派 id**——R2 质询与点名追问将用 send_message 发给存活席位；`,
          `  id 遗失的席位按席位失败处理（全新委派重派，计 reassigns）。`,
        ]
      : []),
    `- 该席阁员的人格文本（见文末"阁员人格"一节，逐字）+ 角色卡全文`,
    `  （职责 / 立场锚点 / 必答一问 / 异质锚点与驳论义务）。`,
    `- 该席钉扎路由（在委派参数 provider/model/reasoning_effort 中下发；`,
    `  征召席省略这三个参数）。`,
    `- 议题原文："${topic}"。`,
    `- 全部其他席位名单（仅名单，不含他人立场）。`,
    `- 需要核验的文件：优先**把关键片段直接内嵌进简报**，或将材料复制进`,
    `  工作区后给绝对路径（子智能体工作区权限收窄于父级；不可达时该席声明`,
    `  "以简报材料为据"）。`,
    `- 输出格式要求：立场书 ≤600 字（目标值；超限如实标注 over_limit、不截断`,
    `  归档）；结尾给出该席**最坚持的一点**与**最没把握的一点**；关键论据标注`,
    `  证据等级——【核验】亲自读文件/跑命令验证过、【推断】由材料推理、`,
    `  【转述】引自他席或外部来源。`,
    ``,
    `**送达核对与超时语义（每轮必做）**：收齐后与派出名单逐一核对；缺席者先用`,
    `list_agents 查状态——已完成而报告缺失的重取一次，仍取不到按缺员处理。`,
    `**等待超时 ≠ 席位失败**：超时且仍在运行 → 续等一次；二次超时或确认失败/中断`,
    `→ 按缺员重派（全新委派 + 简报内嵌该席已有材料，计 reassigns）。长时间无`,
    `完成通知时，先用 list_agents 核对席位状态（仍在跑/已完成/已终止）再决定续等。`,
    ``,
    `**缺员处理**：某席确认缺席，在速览中标注"缺席"，剩余席位照常议事；`,
    `到场不足 3 席时，议定书标记 degraded: true。`,
    ``,
    `### 第 2 步 — 立场速览与中止点（**必须停下等用户**）`,
    ``,
    ...(hasOverview
      ? [
          `收齐并核对后输出立场速览，**两栏对举**：`,
          ``,
          `**共识面**（已稳，无需用户裁决）——每条标强度三级（全场一致/多数/分裂）`,
          `并**枚举支持席位名单**：`,
          `- [全场一致] …（锋/远/谋/众）`,
          `- [多数] …（远/谋/众；锋反对见 D2）`,
          ``,
          `**分歧面**（需要用户裁决）——你判定的实质分歧点清单（编号 D1…，标明`,
          `对立席位：锋 vs 远）。`,
          ``,
          `纪律：强度标签必须枚举席位名单（看出收敛是否来自同质席抱团）；三级封顶，`,
          `更细的刻度是伪精确；**共识面不构成跳轮依据**——跳轮仍只看实质分歧计数。`,
          ``,
        ]
      : [
          `收齐并核对后输出立场速览：每席 ≤100 字摘要 + 你判定的实质分歧点清单（编号）。`,
          ``,
        ]),
    `然后**停止推进**，向用户给出选择：`,
    ``,
    ...(t.rounds > 1
      ? [
          `- "进二轮"：按分歧点组织交叉质询（默认动作，用户无回复时不擅自继续）。`,
        ]
      : [
          `- "升档到进阶"：重新调用 cabinet_start（tier="advanced"、topic 不变）`,
          `  取得含二轮规程的完整计划，按新计划续跑；预算切换为 54K/16 次，已消耗计入。`,
        ]),
    `- "点名 X：问题"：指定某席回答一个追问（${continuation
      ? "send_message 发给该存活席位（其会话已含角色卡与己身 R1，只发问题即可）；失败即退回全新委派、简报内嵌其 R1 立场书原文 + 问题"
      : "全新委派该席，简报内嵌其 R1 立场书原文 + 问题"}）。`,
    `- "合议"：跳过质询直接出议定书。`,
    `- "散会" / "就按X办"：立即输出简版议定书并终止。`,
    ``,
    `**提前收敛边界（优先级裁定：R1 后必停 > 提前收敛自动跳轮 > 预算切换）**：`,
    `实质分歧恰 1 条 → 跳过质询，但仍须输出速览后**停等用户**；0 条 → 注明"首轮即收敛"直接合议。`,
    `降档自动、升档手动。`,
    ``,
    ...(t.rounds > 1
      ? continuation
        ? [
            `### 第 3 步 — 第二轮：交叉质询（续谈优先 + 冷启动兜底）`,
            ``,
            `**续谈优先**：对每个需要质询的席位，用 send_message 发给其存活席位`,
            `（R1 spawn 时保留的 id）。消息包含：`,
            `- 按攻击面规则提供的其他席位 R1 材料（隔离不变量——对手材料只能经你传递）。`,
            `- 你的质询问题。`,
            `- 输出格式要求：先引原文再反驳；每条反驳以 cites: ["席位名#R1-第N点"] 收尾（引用带轮次场次）；`,
            `  被说服时明确说"接受此点"并修正立场，不许和稀泥；关键论据同样标注证据等级。`,
            ``,
            `**冷启动兜底**：任一席 send_message 失败/超时/已终止 → 立即退回全新委派，`,
            `简报内嵌该席全部已有材料（人格+角色卡+R1 原文），计 reassigns，disclosure 注明退化。`,
            `**TTL 规则**：R1 停等超过 10 分钟（缓存失活保守阈值，实测后修订）的席位`,
            `直接按冷启动重派处理，disclosure 注明。`,
            `**升档即冷启动**：升档重调 cabinet_start 后，旧场存活席位一律不再引用`,
            `（席位 id 仅运行期存在）——升档场的 R2 全部按新计划全新委派。`,
            ``,
            `**攻击面（全文优先、摘录兜底）**：预算允许时，每席消息内嵌**全部**其他席位 R1 立场书`,
            `原文 + 指定质询点；不可行时至少内嵌指定质询点原文 + 其余席位速览，并在议定书披露`,
            `"本轮行使了摘录选择权"。`,
            ``,
            `质询材料只做排序传递，**不做语义压缩**——引用必须逐字。`,
            `**升档新增席位**（如有）：无存活会话，直接全新委派、以二轮身份入席，简报内嵌全部 R1 立场书；`,
            `补位优先取未在场的阁员（据/众为通用候补），其次跨包选调，disclosure 注明来源。`,
            ``,
          ]
        : [
            `### 第 3 步 — 第二轮：交叉质询（全新委派 + 内嵌原文）`,
            ``,
            `**不要使用续谈（send_message 唤醒既有子智能体）**：当前为冷启动形态，`,
            `停等边界之后一律全新委派。`,
            `**攻击面（全文优先、摘录兜底）**：预算允许时，每席简报内嵌**全部**其他席位 R1 立场书`,
            `原文 + 指定质询点；不可行时至少内嵌指定质询点原文 + 其余席位速览，并在议定书披露`,
            `"本轮行使了摘录选择权"。`,
            ``,
            `对每个需要质询的席位，发一个**全新 subagent**，简报包含：`,
            `- 该席自己的 R1 立场书**原文**（逐字内嵌，保证立场连续性）。`,
            `- 按上述攻击面规则提供的其他席位材料 + 你的质询问题。`,
            `- 输出格式要求：先引原文再反驳；每条反驳以 cites: ["席位名#R1-第N点"] 收尾（引用带轮次场次）；`,
            `  被说服时明确说"接受此点"并修正立场，不许和稀泥；关键论据同样标注证据等级。`,
            ``,
            `质询材料只做排序传递，**不做语义压缩**——引用必须逐字。`,
            `**升档新增席位**（如有）：跳过 R1，直接以二轮身份入席，简报内嵌全部 R1 立场书；`,
            `补位优先取未在场的阁员（据/众为通用候补），其次跨包选调，disclosure 注明来源。`,
            ``,
          ]
      : []),
    `### 第 ${t.rounds > 1 ? 4 : 3} 步 — 合议与议定书`,
    ``,
    `汇总全部材料，输出议定书（速览 ≤300 字在前，明细在后），protocol.json 按此 schema：`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "schemaVersion": 2,`,
    `  "session": "<时间戳>-<slug>",`,
    `  "tier": "<档位，含升档路径如 standard→advanced>",`,
    `  "topic": "${topic.slice(0, 60)}",`,
    `  "brief": "<≤300 字速览>",`,
    `  "seats": [{"seat": "...", "agent": "...", "model": "...", "conclusion": "...（关键论据带证据等级）"}],`,
    `  "divergence": [{"status": "未弥合|部分弥合|已解决|新发现", "text": "..."}],`,
    `  "decisions": ["<议定条款，编号 P1...>"],`,
    `  "actions": [{"item": "...", "owner": "...", "due": "..."}],`,
    `  "dissent": ["<保留意见>"],`,
    `  "disclosure": "AI 分角色推演 + 各席 provider/model + 单/多源说明 + 补位席注明 + '调用轨未用 N 次'${continuation ? " + '立场连续性由各席会话承载，主持人可见面 = 各席报告文本'" : ""}",`,
    `  "replayable": ${continuation ? "false（续谈形态：R2 依赖宿主会话压缩态，归档为权威记录但不可重放）" : "true（冷启动形态：每轮可由 round-N.jsonl 独立重建）"},`,
    `  "beyond_preanswer": { "count": null, "items": [] },  // 占位（v0.2.5：预答测量链不建）——恒 null，禁止回填`,
    `  "degraded": false,`,
    `  "cost": {"calls": 0, "tokens_est": "...", "cap": "${t.callCap} 次委派 / ${t.tokenCap} token(参考)", "cap_hit": false, "deviation": "calls 与 tokens_est 相对 cap 的实际比值", "reassigns": 0},`,
    `  "archived": true`,
    `}`,
    `\`\`\``,
    ``,
    `硬性规则：**分歧字段为空且未注明"首轮即收敛"不得合议**（须返回补议）；缺 cites 的质询回应`,
    `标注 "cites_missing": true 入档并在议定书披露，不静默接受；跨会话引用必须标注来源会话 id。`,
    ``,
    `### 第 ${t.rounds > 1 ? 5 : 4} 步 — 归档`,
    ``,
    `用你自己的文件工具在项目工作区写入：`,
    ``,
    `\`\`\``,
    `.cabinet/<时间戳>-<slug>/`,
    `├── round-1.jsonl   # 各席立场书原文（席/agent/model/字数/证据等级）`,
    t.rounds > 1 ? `├── round-2.jsonl   # 各席质询回应（含 cites，缺失者标 cites_missing）` : null,
    `├── protocol.json   # 上文 schema v2 全字段`,
    `├── events.jsonl    # 运行日志·最小集（v0.2.2 收窄）：每行 {seq, t, phase, actor, event, detail?}；`,
    `│                   #   t=ISO-8601（实时记录优先；事后补录取可证实下界并标 "t_type":"lower-bound"）；`,
    `│                   #   首行允许一条 session_meta 元数据行；phase 自由文本但建议沿用`,
    `│                   #   intake|setup|R1|R2|steering|upgrade|synthesis|archive|close|cost。`,
    `│                   #   必记三类事件：①派发——event 以 "dispatch:spawn" 或 "dispatch:send_message"`,
    `│                   #   前缀开头，且带 delegationId（多席以分号分隔——审计器据此重建调用数`,
    `│                   #   对账 cost.calls）；②送达——每轮收齐核对；③预算——升档切换、触顶中止、成本决算`,
    `└── index.jsonl     # 追加一行：ts/session/topic/tier/seats/verdict/files/source_doc/calls/gate_blocks/audit/`,
    `│                   #   beyond_preanswer/gate_overrides/card_reactions`,
    `\`\`\``,
    ``,
    `index.jsonl 的 calls = 本场委派总数（dispatch: 前缀事件计数），gate_blocks = 闸拦截次数`,
    `（红队异源中止/预算触顶等），audit = 归档审计器（scripts/audit.mjs）对账结论`,
    `（ok / mismatch:期望≠实际 / 未跑）；beyond_preanswer 为占位列（恒 null，禁止回填）；`,
    `gate_overrides = 误拦恢复放行次数（与 gate_blocks 分列记账）；card_reactions =`,
    `用户对组阁披露卡的答复（确认/改定/散会）。归档后跑一次 node scripts/audit.mjs，`,
    `把结论写入。`,
    ``,
    `归档失败不阻断议定书输出，在议定书末尾标注 archived: false 及原因。`,
    ``,
    `### 全程预算纪律`,
    ``,
    `- **调用轨 = 执法轨**：逐次委派记账（subagent 委派计数），触达 ${t.callCap} 次立即中止议事——`,
    `  以已收材料合成部分议定书，不追加委派、不询问用户。余量依据：1 场实跑观测（PI 侧首场：`,
    `  一次灾备恰好耗尽无余量额度）+ 1 条档案在册的自述记录（v1 原型报告，转述级，非独立核验）；`,
    `  数值在 reassigns 分母 ≥5 场前为暂定。**议程闭合时在 disclosure 记"调用轨未用 N 次"`,
    `  （N＝cap−calls；未动用额度不结转不交易、机会成本记 0，但必须写出）。**`,
    `- **token 轨 = 参考轨（软指标）**：入账不中止；逐场写入 cost.deviation 供成本自校准；`,
    `  量测以接口口径（简报出 + 报告入）为准，子智能体内部读取不可观测时如实注明；`,
    `  R2 全文优先时简报约 ×1.8，属预期超支。`,
    `- **升档即切换预算**：重调本工具（tier="advanced"、topic 不变）取新档计划，已消耗计入新档额度。`,
    `- 429 / 配额失败：换同 provider 家族其他模型重试 1 次（计入委派计数），仍败按缺员处理。`,
    `- 席位失败 / 二次超时：全新委派重派，简报内嵌该席已有材料，计 reassigns——预算已留一整轮`,
    `  重派余量，属常规动作。`,
    ``,
    `### 阁员人格（派发时按映射逐字内嵌进对应席位的简报开头）`,
    ``,
    renderPersonas(ministers),
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

// —— 插件入口 ——

const name = "dsh-cabinet";
const inject = ["tools", "skills"];

const TOOL_DESCRIPTION =
  "开启一场内阁议事：输入议题与场景，返回完整的议事编排计划（席位、模型混编规则、轮次、预算硬顶、中止点）；执行规程见技能 cabinet";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{ministers?: Record<string, {provider:string, model:string, reasoningEffort?:string}>, pool?: Array<{provider:string, model:string, reasoningEffort?:string}>}} config
 */
function apply(ctx, config = {}) {
  // API 形状探针（P2，2026-10-09 首场审议）：插件消费宿主的 ctx.tools /
  // ctx.skills 表面，宿主升版漂移时加载即响亮失败，不静默注册半截功能。
  if (typeof ctx?.tools?.register !== "function" || typeof ctx?.skills?.register !== "function") {
    throw new Error(
      "dsh-cabinet: 宿主 API 形状不符（需要 ctx.tools.register 与 ctx.skills.register）。" +
        "已验证宿主版本见 package.json dsh.verifiedHostVersion；当前宿主可能已升版，请核对后再用。",
    );
  }
  const skills = loadSkills();
  const ministers = loadMinisters();
  if (ministers.length === 0) {
    ctx.logger.warn("dsh-cabinet: ministers/ 为空，阁员人格不可用（全部席位将走征召）");
  }
  const pinning = normalizePinning(config.ministers);
  // 钉扎表响应对账（P7：normalizePinning 静默剔除 → 显式警告，防拼写静默失效）
  const configured = config.ministers && typeof config.ministers === "object" ? Object.keys(config.ministers) : [];
  const dropped = configured.filter((k) => !pinning[k]);
  if (dropped.length > 0) {
    ctx.logger.warn(`dsh-cabinet: 钉扎表条目未生效（键名非法或缺 provider/model）：${dropped.join(", ")}`);
  }
  // 候选池规范化（征召席与回退场景的可选路由；不改动阁员钉扎）
  const pool = normalizePool(config.pool);
  if (Array.isArray(config.pool) && pool.length !== config.pool.length) {
    ctx.logger.warn(
      `dsh-cabinet: 候选池 ${config.pool.length - pool.length} 条非法项被剔除（缺 provider/model）`,
    );
  }

  for (const skill of skills) {
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: "dsh-cabinet",
    });
  }

  ctx.tools.register({
    name: "cabinet_start",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: {
          type: "string",
          description: "议事议题，应是一个需要权衡的决策或问题，而非事实查询",
        },
        scene: {
          type: "string",
          enum: ["coding", "writing", "research", "general"],
          description:
            "议题场景，决定角色包与评分卡维度；缺省 = general（cabinet-roles-research 通用包），由调用方按议题自行选择",
        },
        roles: {
          type: "array",
          items: { type: "string" },
          description: "自定义席位名单，覆盖场景角色包的默认席位；红队批判官为固定席不可移除",
        },
        tier: {
          type: "string",
          enum: ["standard", "advanced", "max"],
          description:
            "议事档位：standard=4席×1轮（默认）、advanced=5席×2轮、max=6席×2轮；升档只能由用户显式指定",
        },
        goal: {
          type: "string",
          description: "本场议事要产出什么，如'一份可执行的迁移方案'",
        },
      },
      required: ["topic"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          instruction: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.ok ? value.instruction : `cabinet_start 失败：${value.error ?? "未知错误"}`,
        },
      ],
    },
    async execute(args) {
      const topic = String(args?.topic ?? "").trim();
      if (!topic) return { ok: false, error: "topic is required" };
      const instruction = buildInstruction({
        topic,
        scene: args?.scene,
        roles: args?.roles,
        tier: args?.tier,
        goal: args?.goal,
        ministers,
        pinning,
        pool,
        continuation: CONTINUATION_ENABLED,
        mechanisms: MECHANISMS,
      });
      return { ok: true, instruction };
    },
  });
}

export {
  apply,
  inject,
  name,
  CONTINUATION_ENABLED,
  MECHANISMS,
  TIERS,
  SCENE_ROLE_PACKS,
  MINISTER_NAMES,
  SEAT_MAPPING,
  modelFamily,
  checkSeatDimensions,
  stripFrontmatter,
  parseFrontmatterMeta,
  loadMinisters,
  loadSkills,
  normalizePinning,
  normalizePool,
  buildInstruction,
};
