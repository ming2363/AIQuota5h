import assert from "node:assert/strict";
import test from "node:test";
import { assessAgyEnvironment } from "../src/providers/antigravity.js";

// 2026-11-05 实测的 agy plugin list --json 输出
const CURRENT = JSON.stringify([
  { name: "android-cli-plugin", enabled: true, version: "1.0.16625370", source: "antigravity-plugins-official", path: "/p/android-cli-plugin", skills: ["android-cli"] },
  { name: "gemini-api", enabled: true, version: "2.3.1", source: "antigravity-plugins-official", path: "/p/gemini-api", skills: ["gemini-api-dev"], mcpServers: ["gemini-api-docs"] },
  { name: "google-antigravity-sdk", enabled: true, version: "0.0.9", source: "antigravity-plugins-official", path: "/p/sdk", skills: ["google-antigravity-sdk"] },
]);
const NO_MCP = "No MCP servers configured.\n";

function withPlugins(extra: object[]): string {
  return JSON.stringify([...JSON.parse(CURRENT), ...extra]);
}

test("当前环境：白名单官方插件、无自配 MCP、无钩子时允许发送", () => {
  assert.deepEqual(assessAgyEnvironment({ pluginsJson: CURRENT, mcpText: NO_MCP, existingHookFiles: [] }), { ok: true, reason: "" });
});

test("启用白名单以外的插件时拦截，已禁用的不影响", () => {
  const extra = { name: "some-plugin", enabled: true, source: "antigravity-plugins-official", path: "/p/x", skills: ["x"] };
  assert.equal(assessAgyEnvironment({ pluginsJson: withPlugins([extra]), mcpText: NO_MCP, existingHookFiles: [] }).ok, false);
  assert.equal(assessAgyEnvironment({ pluginsJson: withPlugins([{ ...extra, enabled: false }]), mcpText: NO_MCP, existingHookFiles: [] }).ok, true);
});

test("存在钩子文件、自配 MCP、非官方来源、未核对的组件或 MCP 时拦截", () => {
  assert.equal(assessAgyEnvironment({ pluginsJson: CURRENT, mcpText: NO_MCP, existingHookFiles: ["/p/gemini-api/hooks.json"] }).ok, false);
  assert.equal(assessAgyEnvironment({ pluginsJson: CURRENT, mcpText: "my-server  stdio  enabled\n", existingHookFiles: [] }).ok, false);
  const plugins = JSON.parse(CURRENT);
  const variant = (patch: object) => JSON.stringify([{ ...plugins[0], ...patch }, plugins[1], plugins[2]]);
  assert.equal(assessAgyEnvironment({ pluginsJson: variant({ source: "github" }), mcpText: NO_MCP, existingHookFiles: [] }).ok, false);
  assert.equal(assessAgyEnvironment({ pluginsJson: variant({ hooks: ["PreInvocation"] }), mcpText: NO_MCP, existingHookFiles: [] }).ok, false);
  assert.equal(assessAgyEnvironment({ pluginsJson: variant({ mcpServers: ["shell"] }), mcpText: NO_MCP, existingHookFiles: [] }).ok, false);
});

test("插件列表无法解析时拦截", () => {
  assert.equal(assessAgyEnvironment({ pluginsJson: "Installed plugins:", mcpText: NO_MCP, existingHookFiles: [] }).ok, false);
});
