# dsh-cabinet · Cabinet 内阁议事

低频重决策的多角色议事编排插件：你提议题，会话智能体担任主持人，召唤  
4–6 个立场不同的阁员（subagent），各自论证 → 交叉质询 → 合议，最后产出  
一份可追溯、可审计的议定书。

## 它用来干嘛

适合**错了代价高、且没有唯一正确答案**的低频重决策——一个智能体独立思考容易  
一叶障目，让立场各异的多个智能体当面对质，把盲区逼出来：

- **架构与技术选型**：monorepo 拆不拆、数据库选谁、老系统怎么迁移——  
  架构官摆方案、成本官算账、红队专职攻击。
- **方案评审**：上线前把方案丢进内阁，审出的问题带强度分级与席位署名，  
  不接受"大家都觉得没问题"的含混合议。
- **写作与研究决策**：选题立意、大纲结构、研究设计的方法审查——coding /  
  research / writing 三套角色包按议题装载，术语与判据随场景切换。

不适合高频琐事：改个 typo、查个 API ——这活儿不适合交给它，性价比太低。议事有固定编排  
成本（standard 档最少 9 次委派调用），且成本偏高，杀鸡焉用牛刀？

## 它怎么工作

- **三档议事，预算硬顶**：standard 4 席×1 轮（9 次调用 / 1.9 万 token）  
  起步，进阶档 5 席×2 轮、最高档 6 席×2 轮；调用数与 token 都有公式化  
  硬顶，说到做到，不会议着议着失控。
- **八席阁员人格 + 模型钉扎**：每个席位有独立人格卡，各自钉扎模型路由  
  （provider / model / reasoningEffort），异质模型混编；红队（锋）强制  
  与主持会话异源——杜绝同一模型自我印证。改钉扎写 profile 配置即可，  
  热生效。
- **提问式停等确认**：组阁后先亮披露卡（席位、模型、预算），问过你再  
  派发——未获确认不调用，确信误拦可放行，单独计数不混账。
- **轮间介入**：补一轮论证、点名追问某一席、合议收束、随时散会——  
  节奏在你手里。
- **产出可追溯**：每场归档 events / index / protocol（JSONL 议定书），  
  两栏速览对举共识与分歧（强度三级 + 席位枚举）；`scripts/audit.mjs`  
  事后机器对账委派数与调用数，对不上会亮红灯。

## 安装

```bash
git clone https://github.com/pertboem-ops/dsh-cabinet.git   # 已克隆可跳过
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 加 "dsh-cabinet": "link:<克隆目录>"，
# （相对或绝对路径均可，示例：link:../../../dsh-cabinet）
# dsh.profile.bundles 列表加 "dsh-cabinet"，然后：
pnpm install
```

重启 dsh（bundle 组合发生在 profile 加载时，HMR 不覆盖 bundles 列表变更）。

**生效语义（实测修正）**：依赖用 `link:` 协议，但 dsh 的 HMR 默认只热载  
**profile 配置**（`dsh-base` 的 hmr 行 `root: []`——模块监听默认关）。  
因此：改 profile `cordis.patch.yml` 里的钉扎 config = 热生效；改本包代码  
（lib/、ministers/、skills/）= 冷变更，须重启 dsh。

## 使用

- 输入 `/cabinet 该不该把 monorepo 拆成多仓库？`，或直接说"开个内阁：……"。
- 升档（只能手动）："开内阁，用进阶档：……"。
- 轮间介入：`进二轮` / `点名 成本官：……` / `合议` / `散会`。

## 改钉扎（阁员模型调节）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，以 `id: dsh-cabinet` 整段  
替换 config（patch 语义是整体替换不是合并，八席要列全；本包发布门含  
profile 覆盖八席齐备检查），保存即热生效，下一场议事按新钉扎解析。  
钉扎原则：**锋必须与会话模型异源**；据/审/众同属 DeepSeek 家族时注意与  
在场他席错开；立用高配、谋用经济档。

钉扎初值已经过 2026-10-09 首场实跑核对：`kimi-coding/k3`、`zai-coding-cn/
glm-5.3(+flash)`、`deepseek-account/deepseek-flash` 三路在册可用（锋因  
该场会话宿主为 k3 撞异源铁律被临场改钉 GLM——属设计内灾备）。回退路由  
`deepseek-official` 在册但需 `DEEPSEEK_API_KEY` 凭据，缺席时请求以  
MISSING_CREDENTIAL 失败。

## 发布门

改动任何文件后先跑：

```bash
node verify.mjs   # 66 项：文件/清单/patch/TIERS 公式/技能预算表/红队铁律文本/双形态关键句/v0.2.5 机制锚句/工具名白名单/阁员结构/审计器自检 + 阻断式 smoke（61 项）
```

环境声明：node --check 与 smoke 两项经子进程执行，在 dsh 沙箱等禁 spawn  
的环境会 EPERM——记 WARN 不记 FAIL（环境性失败不等于代码缺陷）；"全绿"  
声明以普通 Node 环境为准（本机 43/43，2026-10-09）。

## 已知边界（截至 v0.2.6）

- 预算硬顶、cites/字数校验是编排计划中的规则文本，由父智能体自律执行，  
  无代码门执法。机器回读兜底：每场归档后跑  
  `node scripts/audit.mjs`（events 的 dispatch: 前缀/delegationId 重建  
  委派数，对账 cost.calls），结论写入 index.jsonl 的 audit 列。
- **组阁披露卡 + 提问式停等确认（v0.2.6）**：组阁后输出披露卡并用  
  `ask_user_question` 提问（确认开议/改定席位模型/散会），**未获显式确认  
  不派发任何席位**；改定须重检后再次提问。守护半径：卡只保软失配；硬闸  
  （红队异源/三维失败关闭）由代码层在派发前拦截。**误拦恢复通道**：用户  
  确信误报时显式说"误拦恢复：按 X 继续"，放行大写标注并计  
  gate_overrides（与 gate_blocks 分列）。  
  （沿革：v0.2.5 审议曾裁定"不停等、照出即继续"，2026-10-13 用户显式  
  裁决恢复停等——审议理由存档 docs/设计方案-v0.2.5.md，未被删除。）
- **两栏速览（v0.2.5 机制 C）**：共识面（强度三级+席位枚举）/ 分歧面  
  对举；共识面不构成跳轮依据。日落条款：连续 3 场 card_reactions=0 →  
  卡降为 index 行；连续 3 场追问不涉及两栏 → 降为一行摘要。
- **Lead 预答对照不建**（v0.2.5 审议裁决：测量链自指环三节未断）；  
  schema 留 beyond_preanswer 占位（恒 null 禁回填），重启前置三条件  
  见 docs/设计方案-v0.2.5.md §二。
- **续谈形态（CONTINUATION_ENABLED，默认关）**：R2/点名追问续谈存活  
  席位的参数化分支；翻转条件与消亡条款见 docs/设计方案-v0.2.2.md §五。
- token 轨量测真源 = 宿主 `storages/session_projcache` 的 tokenUsage 三桶，  
  主持人代抄；不可得时退回估算并注明。
- 钉扎路由可用性依赖 list_subagent_models 核对；委派参数被拒时回退会话  
  默认模型并记入 disclosure（红队例外：只许落另一钉扎家族，两家皆倒  
  响亮中止——P3）。
- 版本闸：package.json 以 `^0.2.0-rc.2` peer 钉住 dsh-tools/dsh-skill 两个  
  被消费的宿主表面；apply() 内置 API 形状探针兜底。
- 渲染产物工具名受 verify 白名单机检（A2：wait_agent 事故防复发）。

## 实跑记录

- **2026-10-09 首场**：插件真实加载、三路钉扎派发成功、归档四件齐全；  
  促成 v0.1.1（红队铁律三修、判据失败关闭）。
- **2026-10-11 两场**：升档路径合规；探针场实测续谈语义与计量通路；  
  促成 v0.1.2（wait_agent 清理）与 v0.2.2。
- **2026-10-12 审议场**：v0.2.4 方案过内阁审议，裁决落地为 v0.2.5  
  （确认停等改形为披露卡默认继续、预答对照移除留占位、两栏速览照建）。  
  待验：披露卡中断演练（§八）、续谈形态翻转（n≥3 场）、advanced/max  
  完整场、writing/research 场景实跑、TTL 双时点复测。
