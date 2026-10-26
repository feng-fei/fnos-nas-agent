/* format.js —— 展示格式化：按字段名自动识别人类可读单位。 */

const BYTE_UNITS = ["B","KB","MB","GB","TB","PB"];

export function formatBytes(value){
  if(!Number.isFinite(Number(value))) return "—";
  const bytes = Number(value);
  if(bytes === 0) return "0 B";
  let i = 0, a = Math.abs(bytes);
  while(a >= 1024 && i < BYTE_UNITS.length - 1){ a /= 1024; i++; }
  const n = bytes / (1024 ** i);
  const digits = i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:digits}).format(n) + " " + BYTE_UNITS[i];
}
export function formatDurationSeconds(value){
  if(!Number.isFinite(Number(value))) return "—";
  const s = Math.max(0, Math.floor(Number(value)));
  if(s < 60) return s + " 秒";
  const days = Math.floor(s / 86400);
  if(days){ const h = Math.floor(s % 86400 / 3600); return days + " 天" + (h ? " " + h + " 小时" : ""); }
  if(s >= 3600) return Math.floor(s / 3600) + " 小时" + (Math.floor(s % 3600 / 60) ? " " + Math.floor(s % 3600 / 60) + " 分" : "");
  return Math.floor(s / 60) + " 分" + (s % 60 ? " " + (s % 60) + " 秒" : "");
}
export function formatDateTime(value){
  if(value === null || value === undefined || value === "") return "—";
  const d = new Date(value);
  if(!Number.isFinite(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(d);
}
/* 递归把常见度量字段转成人类可读（用于诊断/工具输出的通用渲染）。 */
export function formatDisplayValue(value, key = ""){
  if(Array.isArray(value)) return value.map(item => formatDisplayValue(item, key));
  if(value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, formatDisplayValue(v, k)]));
  if(typeof value === "number"){
    if(/(?:bytes?|BytesScanned)$/i.test(key)) return formatBytes(value);
    if(/(?:duration|elapsed|latency|responseTime|requestTime)Ms$/i.test(key))
      return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1}).format(value) + " ms";
    if(/(?:uptime|duration|elapsed|runtime)Seconds$/i.test(key)) return formatDurationSeconds(value);
    if(/(?:percent|percentage|progress)$/i.test(key))
      return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1}).format(value) + "%";
  }
  if(typeof value === "string" && /(?:At|Date|Timestamp)$/i.test(key) && /^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(value))
    return formatDateTime(value);
  return value;
}
