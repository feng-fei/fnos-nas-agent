import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../apps/fnos-nas-agent/app/task-manager.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("task manager tracks queued, running and completed tasks", async () => {
  const manager = createTaskManager({ execute: async input => ({ echoed: input.text }), id: (() => { let n=0; return () => "task-"+(++n); })() });
  const task = manager.submit({ text: "hello" });
  assert.equal(task.taskId, "task-1");
  assert.ok(["queued","running"].includes(task.status));
  for (let i=0; i<20 && manager.get(task.taskId).status !== "completed"; i++) await tick();
  assert.equal(manager.get(task.taskId).status, "completed");
  assert.deepEqual(manager.get(task.taskId).result, { echoed: "hello" });
});

test("task manager limits concurrency and reports queue state", async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const manager = createTaskManager({ concurrency: 1, execute: async input => { if(input.wait) await blocker; return input; }, id: (() => { let n=0; return () => "t"+(++n); })() });
  const first=manager.submit({wait:true}), second=manager.submit({wait:false});
  await tick();
  assert.equal(manager.stats().running, 1);
  assert.equal(manager.get(second.taskId).status, "queued");
  release();
  for (let i=0; i<20 && manager.get(second.taskId).status !== "completed"; i++) await tick();
  assert.equal(manager.get(first.taskId).status, "completed");
  assert.equal(manager.get(second.taskId).status, "completed");
});

test("task manager sanitizes failures and bounds retained history", async () => {
  const manager=createTaskManager({historyLimit:2,execute:async input=>{if(input.fail)throw Error("secret / password");return {ok:true};},id:(()=>{let n=0;return()=>String(++n);})()});
  const one=manager.submit({fail:true}), two=manager.submit({}), three=manager.submit({});
  for(let i=0;i<30 && !manager.get(three.taskId)?.completedAt;i++) await tick();
  assert.equal(manager.get(one.taskId),null);
  assert.equal(manager.get(two.taskId),null);
  assert.equal(manager.get(three.taskId).status,"completed");
  assert.ok(!JSON.stringify(manager.list()).includes("password"));
});

test("task manager validates options and applies queue limit", async () => {
  assert.throws(()=>createTaskManager({execute:()=>{},concurrency:0}),TypeError);
  const manager=createTaskManager({concurrency:1,queueLimit:1,execute:async()=>new Promise(()=>{})});
  manager.submit({});
  manager.submit({});
  assert.throws(()=>manager.submit({}),{statusCode:429});
});
