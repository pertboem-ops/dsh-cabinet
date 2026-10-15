/**
 * dsh-cabinet 发布门（移植 cabinet 0.2.7 门规精神：门执行被验对象、
 * 数据件真源逐字段机检、阻断式 smoke）。Node 单文件、无依赖：
 *   node verify.mjs
 * 全绿才允许改动后交付。
 *
 * 环境声明（2026-10-09 首场审议 P7）：涉及子进程的检查（node --check、
 * smoke.mjs）在 dsh 沙箱等禁 spawn 的环境会 EPERM——属环境性失败，记 WARN
 * 不记 FAIL（环境性失败不等于代码缺陷）；本门的"全绿"声明以普通 Node
 * 环境为准。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function note(name, detail = "") {
  warn++;
  console.log(`WARN ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. 文件齐全 ──
const REQUIRED_FILES = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "skills/cabinet.md",
  "skills/roles/coding.md",
  "skills/roles/writing.md",
  "skills/roles/research.md",
  "config/tiers.json",
  "schemas/protocol-v2.json",
  ...["feng", "ju", "li", "mou", "yuan", "zhong", "shen", "gu"].map((k) => `ministers/cabinet-${k}.md`),
];
check(
  "文件齐全（17 件）",
  REQUIRED_FILES.every((f) => existsSync(join(ROOT, f))),
  REQUIRED_FILES.filter((f) => !existsSync(join(ROOT, f))).join(","),
);

// ── 2. package.json ──
const pkg = JSON.parse(read("package.json"));
check("package.json name = dsh-cabinet", pkg.name === "dsh-cabinet");
check("package.json type = module", pkg.type === "module");
check("package.json main 指向 lib/index.js", pkg.main === "lib/index.js");
check("package.json 声明 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
// P2 修正版：声明会咬人的 peer（workspace:* 系列被闸门翻译成宿主版本=永不拒装；
// 必须用真实 semver 范围）。闸门源码：dsh-app-boot evaluatePluginCompatibility。
const BITING_RANGE = /^\^?\d+\.\d+\.\d+/; // 以具体版本起头的范围才会与宿主版本比对
check(
  "peer 声明 dsh-tools/dsh-skill 且范围可咬（版本闸生效）",
  BITING_RANGE.test(pkg.peerDependencies?.["@deepseek-ai/dsh-tools"] ?? "") &&
    BITING_RANGE.test(pkg.peerDependencies?.["@deepseek-ai/dsh-skill"] ?? ""),
  JSON.stringify(pkg.peerDependencies),
);
check(
  "记录已验证宿主版本号（成本官附带条款）",
  typeof pkg.dsh?.verifiedHostVersion === "string" && pkg.dsh.verifiedHostVersion.length > 0,
  pkg.dsh?.verifiedHostVersion,
);
check("package.json 无运行时依赖（纯 ctx 服务消费）", Object.keys(pkg.dependencies ?? {}).length === 0);

// ── 3. cordis.patch.yml ──
const patch = read("cordis.patch.yml");
check("patch 含 insert 块", /^- insert:/m.test(patch));
check("patch 行 id = dsh-cabinet", /id:\s*dsh-cabinet/.test(patch));
check("patch 行 name 与包名一致", /name:\s*'dsh-cabinet'/.test(patch));
check(
  "patch 钉扎表八席齐备",
  ["feng", "ju", "li", "mou", "yuan", "zhong", "shen", "gu"].every((k) =>
    new RegExp(`${k}:\\s*\\{\\s*provider:`).test(patch),
  ),
);
const MINISTER_KEY_RE = /^(feng|ju|li|mou|yuan|zhong|shen|gu)$/;
check(
  "patch 钉扎表无幽灵阁员键",
  [...patch.matchAll(/^\s{10}([a-z]+):\s*\{/gm)].every((m) => MINISTER_KEY_RE.test(m[1])),
  [...patch.matchAll(/^\s{10}([a-z]+):\s*\{/gm)].map((m) => m[1]).join(","),
);

// P7：profile 同名 id 冲突检查——用户 profile patch 的 id: dsh-cabinet 会整体
// 替换本包 config（patch 语义），其 ministers 必须八席列全，否则缺席静默走征召。
const profilePatchPath = join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
if (!existsSync(profilePatchPath)) {
  note("profile 同名 id 冲突检查", `未找到 ${profilePatchPath}（非本机默认 profile 路径），跳过`);
} else {
  const profilePatch = readFileSync(profilePatchPath, "utf8");
  const block = profilePatch.match(/id:\s*dsh-cabinet\b[\s\S]*?(?=\n-\s|\n*$(?![\s\S]))/);
  if (!block) {
    check("profile 无 id: dsh-cabinet 覆盖（用包内默认钉扎）", true);
  } else {
    const missing = ["feng", "ju", "li", "mou", "yuan", "zhong", "shen", "gu"].filter(
      (k) => !new RegExp(`${k}:\\s*\\{\\s*provider:`).test(block[0]),
    );
    check(
      "profile 覆盖的钉扎表八席列全（整体替换语义）",
      missing.length === 0,
      missing.length ? `缺：${missing.join(",")}` : "八席齐备",
    );
  }
}

// ── 4. 门执行被验对象：node --check lib/index.js + smoke 阻断（EPERM 记 WARN）──
for (const [label, args] of [
  ["node --check lib/index.js", ["--check", join(ROOT, "lib", "index.js")]],
  ["smoke.mjs 全过（阻断）", [join(ROOT, "smoke.mjs")]],
]) {
  try {
    execFileSync(process.execPath, args, { stdio: "pipe" });
    check(label, true);
  } catch (e) {
    const detail = String(e.stderr ?? "") + String(e.stdout ?? "") + String(e.message ?? e);
    if (detail.includes("EPERM")) note(label, "EPERM：当前环境禁子进程（如 dsh 沙箱），环境性失败非代码缺陷");
    else check(label, false, detail);
  }
}

// ── 5. TIERS 公式机检（lib 字面量 == config/tiers.json 逐字段）──
const tiers = JSON.parse(read("config/tiers.json")).tiers;
const libSrc = read("lib/index.js");
const lib = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);
for (const [name, t] of Object.entries(tiers)) {
  const lit = lib.TIERS[name];
  check(
    `TIERS[${name}] 逐字段一致`,
    lit &&
      ["seats", "rounds", "nominalTokens", "tokenCap", "callCap", "nominal", "estimate"].every(
        (k) => lit[k] === t[k],
      ),
  );
  // 公式机检：callCap = seats*rounds + seats + 1；tokenCap = 标称×1.1+次均成本四舍五入至千位
  check(`TIERS[${name}] callCap 公式`, t.callCap === t.seats * t.rounds + t.seats + 1);
  const tokenFormula = Math.round((t.nominalTokens * 1.1 + t.nominalTokens / (t.seats * t.rounds)) / 1000) * 1000;
  check(`TIERS[${name}] tokenCap 公式`, t.tokenCap === tokenFormula, `算得 ${tokenFormula}`);
}
check("lib 导出 TIERS 三档", Object.keys(lib.TIERS).sort().join(",") === "advanced,max,standard");

// ── 5b. 技能预算表机检（P7：skills/cabinet.md 表格 == tiers.json，砍生成器后补锁）──
const skillMain = read("skills/cabinet.md");
for (const [name, t] of Object.entries(tiers)) {
  check(
    `技能档位表[${name}] 与 tiers.json 一致`,
    skillMain.includes(`${t.seats} 席 × ${t.rounds} 轮`) &&
      skillMain.includes(`**${t.callCap} 次委派**`) &&
      skillMain.includes(String(Math.round(t.tokenCap / 1000) + "K")),
    `${t.seats}席×${t.rounds}轮 / ${t.callCap}次 / ${Math.round(t.tokenCap / 1000)}K`,
  );
}

// ── 6. 技能 frontmatter（dsh SKILL_NAME 正则 + description 非空）──
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
for (const rel of ["skills/cabinet.md", "skills/roles/coding.md", "skills/roles/writing.md", "skills/roles/research.md"]) {
  const meta = lib.parseFrontmatterMeta(read(rel));
  check(`技能 ${rel} frontmatter 合法`, !!meta && SKILL_NAME.test(meta.name) && meta.description.length > 0, meta?.name);
}
check(
  "角色包席位引用真实阁员名（无 PI 侧 cabinet- 前缀残留）",
  !/cabinet-(feng|ju|li|mou|yuan|zhong|shen|gu)/.test(
    ["skills/cabinet.md", "skills/roles/coding.md", "skills/roles/writing.md", "skills/roles/research.md"]
      .map(read)
      .join("\n"),
  ),
);
check(
  "技能文本无 PI 工具名残留（plugin_local_cabinet_start / TaskWait / TaskList）",
  !/plugin_local_cabinet_start|TaskWait|TaskList/.test(
    ["skills/cabinet.md", "skills/roles/coding.md", "skills/roles/writing.md", "skills/roles/research.md"]
      .map(read)
      .join("\n"),
  ),
);

// ── 6b. 红队铁律执法文本在计划与技能中双侧在册（P3）──
check(
  "计划含红队回退例外（只许落另一钉扎家族/两家皆倒响亮中止）",
  libSrc.includes("回退只许改落另一钉扎 provider 家族") && libSrc.includes("响亮中止组阁"),
);
check(
  "计划含失配披露写入简报",
  libSrc.includes("失配披露写入简报"),
);
check(
  "技能含红队回退例外与失败关闭",
  skillMain.includes("两家皆不可用则响亮中止组阁") && skillMain.includes("判定失败关闭"),
);

// ── 6c. 双形态关键句机检（v0.2.2 P7/D4：两版计划各自完备且不互染）──
const ministersForPlan = lib.loadMinisters();
const planCold = lib.buildInstruction({ topic: "门检", tier: "advanced", ministers: ministersForPlan, pinning: {}, continuation: false });
const planCont = lib.buildInstruction({ topic: "门检", tier: "advanced", ministers: ministersForPlan, pinning: {}, continuation: true });
check(
  "冷启动形态关键句齐备",
  planCold.includes("不要使用续谈") && planCold.includes("全新委派") && planCold.includes('"replayable": true'),
);
check(
  "续谈形态关键句齐备",
  planCont.includes("续谈优先") && planCont.includes("冷启动兜底") && planCont.includes("升档即冷启动") &&
    planCont.includes('"replayable": false') && planCont.includes("立场连续性由各席会话承载"),
);
check(
  "双形态不互染",
  !planCold.includes("续谈优先") && !planCont.includes("不要使用续谈（send_message 唤醒既有子智能体）"),
);
check("续谈开关为代码常量且默认 false", /const CONTINUATION_ENABLED = false;/.test(libSrc));

// ── 6e. v0.2.5 机制短锚句机检（A′披露卡/C两栏/误拦恢复/占位；锚句 ≤8 字）──
check("机制集在册（MECHANISMS 常量）", /const MECHANISMS = \["A-card", "C-overview"\];/.test(libSrc));
for (const anchor of ["组阁披露", "守护半径", "误拦恢复", "共识面", "分歧面", "gate_overrides", "card_reactions", "beyond_preanswer"]) {
  check(`锚句在册：${anchor}`, libSrc.includes(anchor));
}
check(
  "披露卡为提问式停等确认（v0.2.6）",
  planCold.includes("ask_user_question") && planCold.includes("确认开议") && planCold.includes("停下等用户"),
);
check("两栏速览带席位枚举强制句", planCold.includes("枚举支持席位名单"));
check(
  "披露卡位于 R1 派发之前（顺序断言）",
  planCold.indexOf("组阁披露") > 0 && planCold.indexOf("组阁披露") < planCold.indexOf("第 1 步"),
);
check("机制集可日落（mechanisms=[] 时卡体与两栏消失）", (() => {
  const bare = lib.buildInstruction({ topic: "门检", tier: "advanced", ministers: ministersForPlan, pinning: {}, mechanisms: [] });
  return !bare.includes("第 0.5 步") && !bare.includes("ask_user_question") && !bare.includes("共识面");
})());
// index 列名 ⊆ schema indexColumns 一致性
const indexCols = (JSON.parse(read("schemas/protocol-v2.json")).indexColumns ?? "").split("（")[0].split("/").filter(Boolean);
check(
  "index 列名 ⊆ schema indexColumns 且全部在计划文本出现",
  indexCols.length > 0 && indexCols.every((c) => planCold.includes(c)),
  indexCols.join("/"),
);

// ── 6d. 工具名白名单（v0.2.2 A2：渲染产物中的 snake_case 工具/参数名须 ∈ 宿主已挂载名单）──
// 缘起：v0.1.1 计划文本引用宿主不存在的 wait_agent（凭文档写工具名事故）。
// 扫描对象 = 渲染后的计划文本 + 技能正文（不扫源码注释）。
const HOST_TOOLS = ["cabinet_start", "subagent", "subagent_fork", "send_message", "interrupt_agent", "list_agents", "list_subagent_models", "skill", "ask_user_question"];
const KNOWN_PARAMS = ["run_in_background", "reasoning_effort"];
const KNOWN_FIELDS = ["cites_missing", "tokens_est", "t_type", "source_doc", "session_meta", "over_limit", "gate_blocks", "cap_hit", "gate_overrides", "card_reactions", "beyond_preanswer"];
const TOKEN_WHITELIST = new Set([...HOST_TOOLS, ...KNOWN_PARAMS, ...KNOWN_FIELDS]);
const skillBodies = ["skills/cabinet.md", "skills/roles/coding.md", "skills/roles/writing.md", "skills/roles/research.md"]
  .map((rel) => lib.stripFrontmatter(read(rel)))
  .join("\n");
const renderedCorpus = [planCold, planCont, skillBodies].join("\n");
const unknownTokens = [
  ...new Set(renderedCorpus.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []),
].filter((tok) => !TOKEN_WHITELIST.has(tok));
check(
  "工具/参数名白名单（渲染产物无未知 snake_case 标识符）",
  unknownTokens.length === 0,
  unknownTokens.join(","),
);
check(
  "渲染产物无 wait_agent 残留",
  !renderedCorpus.includes("wait_agent"),
);

// ── 7. 阁员定义结构 ──
const ministers = lib.loadMinisters();
check("阁员八席齐备", ministers.length === 8);
check(
  "阁员人格正文最短长度（>100 字符）",
  ministers.every((m) => m.persona.trim().length > 100),
);
check(
  "阁员人格无写死立场句式（你反对/你支持 开头句）",
  ministers.every((m) => !/^你(反对|支持)/m.test(m.persona)),
);

// ── 8. 议定书真源在包内 ──
const protocol = JSON.parse(read("schemas/protocol-v2.json"));
check("protocol schema = cabinet-protocol/2", protocol.schema === "cabinet-protocol/2");
check(
  "protocol 含 degraded/deviation/reassigns（v2 字段）",
  !!protocol.fields.degraded && !!protocol.fields.cost.fields.deviation && !!protocol.fields.cost.fields.reassigns,
);
check(
  "protocol 含 replayable（v0.2.2 续谈披露字段）与 dispatch 前缀约定",
  protocol.fields.replayable?.since === "2.2-dsh" && protocol.eventsRules?.mustCover?.includes("dispatch:spawn"),
);
check(
  "protocol 含 beyond_preanswer 占位（恒 null 禁回填）",
  protocol.fields.beyond_preanswer?.since === "2.4-dsh" && protocol.fields.beyond_preanswer.note.includes("禁止回填"),
);

// ── 9. 归档审计器自检（对包内真实归档对账）──
try {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "audit.mjs"), ROOT], { stdio: "pipe" }).toString();
  check("audit.mjs 对账既有归档", /审计 \d+ 场，0 场不一致/.test(out), out.trim().split("\n").pop());
} catch (e) {
  // EPERM 可能只出现在 e.message（stdout/stderr 为空对象/undefined），一并拼入
  const detail = String(e.stdout ?? "") + String(e.stderr ?? "") + String(e.message ?? "");
  if (detail.includes("EPERM")) note("audit.mjs 对账既有归档", "EPERM：当前环境禁子进程");
  else check("audit.mjs 对账既有归档", false, detail);
}

console.log(`\n结果：${pass + fail + warn} 项检查，${fail} 项失败，${warn} 项警告（环境性）`);
process.exit(fail > 0 ? 1 : 0);
