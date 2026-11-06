// 把“未来几天的提醒”推到腾讯云函数上，让云端每分钟自己检查。
// 队列直接编进函数代码里（环境变量单值上限 64 字节，存不了）。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { callApi } from "./tc3.mjs";
import { makeZip } from "./zip.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "cloud", "scf", "index.js");
const RUNTIMES = ["Nodejs18.15", "Nodejs16.13", "Nodejs20.19"];
const HANDLER = "index.main_handler";

async function buildCode(queue) {
  const raw = await readFile(TEMPLATE, "utf8");
  const json = JSON.stringify(queue).replace(/<\//g, "<\\/");
  if (!raw.includes("/*__QUEUE__*/")) throw new Error("函数模板里找不到 /*__QUEUE__*/ 标记");
  const code = raw.replace("/*__QUEUE__*/ []", `/*__QUEUE__*/ ${json}`);
  return makeZip([{ name: "index.js", data: Buffer.from(code, "utf8") }]).toString("base64");
}

function base(cfg) {
  return {
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    region: cfg.region || "ap-guangzhou",
    functionName: cfg.functionName || "todo-reminder"
  };
}

// 新账号第一次用云函数时没有执行角色，CreateFunction 会报 ResourceNotFound.Role。
// 这里按控制台的做法把 SCF_QcsRole 建出来（托管策略 QcloudSCFFullAccess）。
async function ensureRole(cfg) {
  const cam = {
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    service: "cam",
    version: "2019-01-16",
    region: ""
  };
  const roleName = "SCF_QcsRole";

  let uin = "";
  try {
    const r = await callApi({ ...cam, action: "GetUserAppId", payload: {} });
    uin = String(r.Uin || r.OwnerUin || "");
  } catch { /* 拿不到不影响，云服务角色不依赖 uin */ }

  // 云服务角色：信任策略让 scf 服务来扮演，不是给账号里的用户用
  const trust = {
    version: "2.0",
    statement: [{
      action: "sts:AssumeRole",
      effect: "allow",
      principal: { service: "scf.qcloud.com" }
    }]
  };

  try {
    await callApi({
      ...cam,
      action: "CreateRole",
      payload: { RoleName: roleName, PolicyDocument: JSON.stringify(trust), Description: "云函数执行角色" }
    });
  } catch (err) {
    // 已经存在就是好事，别当失败
    if (!/InUse|Exist|已存在/i.test(err.message)) {
      if (!/not exist|未开通/i.test(err.message)) throw err;
    }
  }

  // 绑托管策略：控制台建角色时会自动绑，纯 API 建的不带，缺了会 CreateFailed
  try {
    const list = await callApi({ ...cam, action: "ListPolicies", payload: { Page: 1, Rp: 100, Scope: "QCS", Keyword: "SCFFullAccess" } });
    const hit = (list.List || []).find(p => p.PolicyName === "QcloudSCFFullAccess");
    if (hit && hit.PolicyId != null) {
      await callApi({ ...cam, action: "AttachRolePolicy", payload: { PolicyId: hit.PolicyId, AttachRoleName: roleName } });
    }
  } catch { /* 已经绑过就忽略 */ }
  return roleName;
}

async function exists(cfg) {
  const b = base(cfg);
  try {
    const r = await callApi({ ...b, action: "GetFunction", payload: { FunctionName: b.functionName } });
    // 上一次建失败留下的残骸，删掉重来，否则永远卡在 CreateFailed
    if (r.Status === "CreateFailed") {
      try {
        await callApi({ ...b, action: "DeleteFunction", payload: { FunctionName: b.functionName } });
        for (let i = 0; i < 10; i++) {
          await new Promise(s => setTimeout(s, 1500));
          try { await callApi({ ...b, action: "GetFunction", payload: { FunctionName: b.functionName } }); }
          catch { return false; }
        }
      } catch { /* 删不掉就继续，后面会报错 */ }
      return false;
    }
    return true;
  } catch (err) {
    if (/ResourceNotFound|not exist|不存在/i.test(err.message)) return false;
    throw err;
  }
}

/** 只更新代码（队列变了时用），函数和触发器已存在 */
export async function pushQueue(cfg, queue) {
  const b = base(cfg);
  const zip = await buildCode(queue);
  await callApi({
    ...b,
    action: "UpdateFunctionCode",
    payload: { FunctionName: b.functionName, ZipFile: zip }
  });
  return { ok: true, count: queue.length };
}

/** 首次部署：建函数 + 建每分钟定时触发器；已存在就只更新队列 */
export async function ensure(cfg, queue) {
  const b = base(cfg);
  const spb = String(cfg.wxpusherSpt || "").trim();
  if (!spb) throw new Error("没有 WxPusher 的 SPT");
  const zip = await buildCode(queue);

  if (await exists(cfg)) {
    await pushQueue(cfg, queue);
    await ensureTrigger(cfg);
    return { ok: true, created: false, count: queue.length };
  }

  let lastErr = null;
  const role = await ensureRole(cfg);
  for (const runtime of RUNTIMES) {
    try {
      await callApi({
        ...b,
        action: "CreateFunction",
        payload: {
          FunctionName: b.functionName,
          Runtime: runtime,
          Handler: HANDLER,
          Type: "Event",
          Role: role,
          Code: { ZipFile: zip },
          MemorySize: 128,
          Timeout: 20,
          Description: "待办提醒云端守时器（电脑关机时到点推送）",
          Environment: { Variables: [{ Key: "WXPUSHER_SPT", Value: spb }] }
        }
      });
      await ensureTrigger(cfg);
      return { ok: true, created: true, runtime, count: queue.length };
    } catch (err) {
      lastErr = err;
      // 只有“运行环境不支持”才换下一个，别把真错误吞掉
      if (!/Runtime|runtime/i.test(err.message)) throw err;
    }
  }
  throw lastErr;
}

async function waitActive(cfg, tries = 15) {
  const b = base(cfg);
  for (let i = 0; i < tries; i++) {
    try {
      const r = await callApi({ ...b, action: "GetFunction", payload: { FunctionName: b.functionName } });
      if (!r.Status || r.Status === "Active") return true;
    } catch { /* 刚建好可能还查不到，继续等 */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

async function ensureTrigger(cfg) {
  const b = base(cfg);
  await waitActive(cfg);
  try {
    const r = await callApi({ ...b, action: "ListTriggers", payload: { FunctionName: b.functionName } });
    const hit = (r.Triggers || []).find(t => t.TriggerName === "every-minute");
    if (hit) return { ok: true, existed: true };
  } catch { /* 列不出来就直接建，重复建会报已存在，下面吞掉 */ }
  try {
    await callApi({
      ...b,
      action: "CreateTrigger",
      payload: {
        FunctionName: b.functionName,
        TriggerName: "every-minute",
        Type: "timer",
        TriggerDesc: "0 */1 * * * * *",
        Enable: "1"
      }
    });
  } catch (err) {
    if (!/已存在|Exist/i.test(err.message)) throw err;
  }
  return { ok: true, existed: false };
}

/** 手工跑一次，验证函数活着 */
export async function invokeTest(cfg) {
  const b = base(cfg);
  const r = await callApi({
    ...b,
    action: "Invoke",
    payload: {
      FunctionName: b.functionName,
      InvocationType: "RequestResponse",
      ClientContext: JSON.stringify({ test: true })
    }
  });
  let ret = null;
  const msg = r.Result?.RetMsg;
  try { ret = typeof msg === "string" ? JSON.parse(msg) : msg; } catch { ret = msg; }
  return { ok: true, ret };
}
