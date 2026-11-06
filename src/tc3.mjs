// 腾讯云 API 的 TC3-HMAC-SHA256 签名。
// 只做本项目用到的几个 SCF 接口，不引 SDK。
import crypto from "node:crypto";

const sha256hex = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, s) => crypto.createHmac("sha256", key).update(s, "utf8").digest();

/**
 * 调一次腾讯云 API。
 * @param {{secretId:string, secretKey:string, action:string, version?:string, region?:string, service?:string, payload?:object}} opt
 */
export async function callApi(opt) {
  const {
    secretId,
    secretKey,
    action,
    version = "2018-04-16",
    region = "ap-guangzhou",
    service = "scf",
    payload = {}
  } = opt;

  if (!secretId || !secretKey) throw new Error("缺少 SecretId / SecretKey");

  const host = `${service}.tencentcloudapi.com`;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST", "/", "", canonicalHeaders, signedHeaders, sha256hex(body)
  ].join("\n");

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256hex(canonicalRequest)
  ].join("\n");

  const kDate = hmac(Buffer.from("TC3" + secretKey, "utf8"), date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, "tc3_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const headers = {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Type": contentType,
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": version,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Region": region
  };

  const res = await fetch(`https://${host}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(25000)
  });

  const j = await res.json().catch(() => null);
  const r = j && j.Response;
  if (!r) throw new Error(`返回值看不懂：HTTP ${res.status}`);
  if (r.Error) throw new Error(`${r.Error.Code}${r.Error.Message ? "：" + r.Error.Message : ""}`);
  return r;
}
