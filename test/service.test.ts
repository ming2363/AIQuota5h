import assert from "node:assert/strict";
import test from "node:test";
import { controlService } from "../src/service.js";

function service(loaded = true, running = true) {
  const calls: string[][] = [];
  const state = { loaded, running, stuck: false, fail: "" };
  const options = {
    attempts: 3,
    installed: () => true,
    isRunning: async () => state.running,
    sleep: async () => {},
    run: (args: string[]) => {
      calls.push(args);
      if (args[0] === state.fail) return { code: 5, stdout: "", stderr: "Permission denied" };
      if (args[0] === "print") return state.loaded
        ? { code: 0, stdout: "state = running", stderr: "" }
        : { code: 113, stdout: "", stderr: "Could not find service" };
      if (args[0] === "bootout") { state.loaded = false; if (!state.stuck) state.running = false; }
      if (args[0] === "bootstrap") state.loaded = true;
      if (args[0] === "kickstart" && !state.stuck) state.running = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { state, calls, options };
}

test("完全退出卸载 KeepAlive 服务并确认进程停止，不禁用下次登录启动", async () => {
  const ctx = service();
  await controlService("stop", ctx.options);
  assert.equal(ctx.state.loaded, false);
  assert.equal(ctx.state.running, false);
  assert.deepEqual(ctx.calls.map((args) => args[0]), ["print", "bootout", "print"]);
  assert.equal(ctx.calls.some((args) => args[0] === "disable" || args[0] === "remove"), false);
});

test("后台已完全停止时重复退出也成功", async () => {
  const ctx = service(false, false);
  await controlService("stop", ctx.options);
  assert.deepEqual(ctx.calls.map((args) => args[0]), ["print", "print"]);
});

test("卸载命令返回后服务短暂仍存在，等待卸载完成而非提前报错", async () => {
  const ctx = service();
  let removing = false;
  let polls = 0;
  const run = (args: string[]) => {
    if (args[0] === "bootout") removing = true;
    else if (args[0] === "print" && removing && polls++ === 0) {
      return { code: 0, stdout: "state = terminating", stderr: "" };
    }
    return ctx.options.run(args);
  };
  await controlService("stop", { ...ctx.options, run });
  assert.equal(polls, 2);
  assert.equal(ctx.state.running, false);
});

test("服务一直没有卸载时不能因进程暂时停止而报告成功", async () => {
  const ctx = service(true, false);
  const run = (args: string[]) => args[0] === "bootout"
    ? { code: 0, stdout: "", stderr: "" } : ctx.options.run(args);
  await assert.rejects(controlService("stop", { ...ctx.options, run }), /尚未停止/);
});

test("停止失败或进程尚未退出时拒绝报告成功", async () => {
  const denied = service();
  denied.state.fail = "bootout";
  await assert.rejects(controlService("stop", denied.options), /停止失败/);
  assert.equal(denied.state.running, true);
  const stuck = service();
  stuck.state.stuck = true;
  await assert.rejects(controlService("stop", stuck.options), /尚未停止/);
  assert.equal(stuck.state.loaded, false);
  assert.equal(stuck.state.running, true);
});

test("无法检查服务时不执行卸载或启动", async () => {
  for (const action of ["start", "stop"] as const) {
    const ctx = service(false, false);
    ctx.state.fail = "print";
    await assert.rejects(controlService(action, ctx.options), /无法检查/);
    assert.deepEqual(ctx.calls.map((args) => args[0]), ["print"]);
  }
});

test("完全退出后重新打开，加载原服务并启动，无须重新安装", async () => {
  const ctx = service();
  await controlService("stop", ctx.options);
  ctx.calls.length = 0;
  await controlService("start", ctx.options);
  assert.equal(ctx.state.running, true);
  assert.deepEqual(ctx.calls.map((args) => args[0]), ["print", "bootstrap", "kickstart"]);
  assert.equal(ctx.calls[1][2].endsWith("com.zhangming.aiquota5h.plist"), true);
});

test("后台已运行时打开界面不会重启后台或创建第二个实例", async () => {
  const ctx = service();
  await controlService("start", ctx.options);
  assert.equal(ctx.calls.length, 0);
});

test("服务已加载但未运行时只启动，不重复 bootstrap 或强制重启", async () => {
  const ctx = service(true, false);
  await controlService("start", ctx.options);
  assert.deepEqual(ctx.calls.map((args) => args[0]), ["print", "kickstart"]);
  assert.equal(ctx.calls.some((args) => args.includes("-k")), false);
});

test("未安装、加载失败或启动未确认均返回明确错误", async () => {
  const missing = service(false, false);
  await assert.rejects(controlService("start", { ...missing.options, installed: () => false }), /尚未安装/);
  assert.equal(missing.calls.length, 0);
  const failed = service(false, false);
  failed.state.fail = "bootstrap";
  await assert.rejects(controlService("start", failed.options), /启动失败/);
  const stuck = service(false, false);
  stuck.state.stuck = true;
  await assert.rejects(controlService("start", stuck.options), /启动尚未确认/);
});
