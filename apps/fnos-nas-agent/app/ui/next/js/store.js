/* store.js —— 约 45 行的 signal 状态管理：单一数据源，组件订阅自动重渲染。
 * const s = signal(0); s();          // 读取
 * s.set(1);                          // 写入并通知
 * s.update(fn);                      // 基于旧值写入
 * const stop = s.sub(fn);            // 订阅，返回取消函数
 * effect(fn) 首次立即执行，并在其读取过的任一 signal 变化后自动重跑；
 * 返回的停止函数会解除所有已收集的订阅（页面切换时调用，防泄漏）。 */

const currentEffect = { fn:null, collected:null };

export function signal(initial){
  let value = initial;
  const subs = new Set();
  function read(){
    if(currentEffect.fn){
      subs.add(currentEffect.fn);
      if(currentEffect.collected) currentEffect.collected.add(() => subs.delete(currentEffect.fn));
    }
    return value;
  }
  read.set = next => {
    if(Object.is(next, value)) return;
    value = next;
    for(const fn of [...subs]) fn(value);
  };
  read.update = fn => read.set(fn(value));
  read.sub = fn => { subs.add(fn); return () => subs.delete(fn); };
  return read;
}

export function effect(fn){
  const collected = new Set();
  const run = () => {
    for(const un of collected) un();
    collected.clear();
    const prevFn = currentEffect.fn, prevCol = currentEffect.collected;
    currentEffect.fn = run; currentEffect.collected = collected;
    try{ fn(); } finally { currentEffect.fn = prevFn; currentEffect.collected = prevCol; }
  };
  run();
  return () => { for(const un of collected) un(); collected.clear(); };
}

/* 全局共享状态（页面模块从这里取，不各自建局部单例）。 */
export const store = {
  session: signal({ state:"loading" }),   // loading | setup | login | ready
  route: signal({ id:"home" }),
  health: signal(null),
  executionMode: signal(null),
  refreshTick: signal(0),                 // 顶栏刷新按钮：页面订阅它重跑加载
};
export function requestRefresh(){ store.refreshTick.update(n => n + 1); }
