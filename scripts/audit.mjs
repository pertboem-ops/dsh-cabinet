#!/usr/bin/env node
/**
 * dsh-cabinet 归档审计器（v0.2.2，议定 P9/审议场"纪律层机器回读"落地）。
 *
 * 对账逻辑：读 .cabinet/<场>/events.jsonl，重建实际委派数
 * （event 以 "dispatch:spawn" 或 "dispatch:send_message" 前缀开头的事件计数，
 * 兼容 v0.2.2 前旧档：退回 detail 含委派语义的启发式计数并标注估计），
 * 与 protocol.json 的 cost.calls 对账；对不上即报。
 *
 * 用法：
 *   node scripts/audit.mjs [工作区根]      # 审计 <根>/.cabinet/ 下全部场次
 * 输出每场一行结论；任一 mismatch 以非零码退出。
 * 纯 Node、无依赖、只读。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const cabinetDir = join(root, ".cabinet");

if (!existsSync(cabinetDir)) {
  console.log(`无归档目录：${cabinetDir}`);
  process.exit(0);
}

let mismatch = 0;
let audited = 0;

for (const dir of readdirSync(cabinetDir).sort()) {
  const eventsPath = join(cabinetDir, dir, "events.jsonl");
  const protocolPath = join(cabinetDir, dir, "protocol.json");
  if (!existsSync(eventsPath) || !existsSync(protocolPath)) continue;
  audited++;

  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    });
  const badLines = events.filter((e) => e === null).length;

  // 委派计数口径（v0.2.2）：event 以 dispatch:spawn/dispatch:send_message 前缀
  // 开头，或带 delegationId 字段（旧档实测形态）；委派数 = delegationId 中
  // 分号分隔的 id 个数（无 delegationId 的 dispatch: 事件计 1）。
  let counted = 0;
  let sawDispatch = false;
  for (const e of events) {
    if (!e || e.session_meta) continue;
    const isPrefix = typeof e.event === "string" && /^dispatch:(spawn|send_message)\b/.test(e.event);
    const hasIds = typeof e.delegationId === "string" && e.delegationId.trim().length > 0;
    if (!isPrefix && !hasIds) continue;
    sawDispatch = true;
    if (hasIds) counted += e.delegationId.split(/[;；]/).filter((s) => s.trim().length > 0).length;
    else counted += 1;
  }
  const mode = sawDispatch ? "delegationId" : "none";

  let protocol;
  try {
    protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
  } catch (e) {
    console.log(`${dir}: ERROR protocol.json 不可解析 — ${e.message}`);
    mismatch++;
    continue;
  }
  const declared = protocol?.cost?.calls;
  const replayable = protocol?.replayable;
  const rNote = replayable === undefined ? "" : ` replayable=${replayable}`;

  if (typeof declared !== "number") {
    console.log(`${dir}: WARN cost.calls 非数值（${JSON.stringify(declared)}），跳过对账${rNote}`);
    continue;
  }
  if (mode === "none") {
    console.log(`${dir}: WARN events 无 dispatch 前缀/delegationId 字段，无法重建委派数${rNote}`);
    continue;
  }
  if (counted === declared) {
    console.log(`${dir}: ok calls=${declared}（events ${mode} 口径一致）${rNote}`);
  } else {
    console.log(`${dir}: mismatch declared=${declared} vs events=${counted}（${mode} 口径）${rNote}`);
    mismatch++;
  }
  if (badLines > 0) console.log(`${dir}: WARN ${badLines} 行 events 不可解析`);
}

console.log(`\n审计 ${audited} 场，${mismatch} 场不一致`);
process.exit(mismatch > 0 ? 1 : 0);
