import assert from "node:assert/strict";
import test from "node:test";
import { fetchBilling, parseCredits } from "../src/providers/grok.js";
import { ProviderHttpError, retryAfterMs } from "../src/providers/http.js";

const START = Date.parse("2026-10-30T01:47:00Z"), END = START + 7 * 86400_000;
function vi(value: number): Buffer {
  let n = BigInt(value); const out: number[] = [];
  do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(out);
}
function int(field: number, value: number): Buffer { return Buffer.concat([vi(field * 8), vi(value)]); }
function msg(field: number, value: Buffer): Buffer { return Buffer.concat([vi(field * 8 + 2), vi(value.length), value]); }
function float(field: number, value: number): Buffer {
  const data = Buffer.alloc(4); data.writeFloatLE(value); return Buffer.concat([vi(field * 8 + 5), data]);
}
function frame(value: Buffer, trailer = false): Buffer {
  const head = Buffer.alloc(5); head[0] = trailer ? 128 : 0; head.writeUInt32BE(value.length, 1); return Buffer.concat([head, value]);
}
function config(percent: number | null, unified = true): Buffer {
  return Buffer.concat([
    ...(percent == null ? [] : [float(1, percent)]),
    msg(8, Buffer.concat([int(1, 2), msg(2, int(1, START / 1000)), msg(3, int(1, END / 1000))])),
    ...(unified ? [int(11, 1)] : []),
    // A product-specific percentage must never be mistaken for the total.
    msg(7, Buffer.concat([int(1, 2), float(2, 39)])),
  ]);
}
function response(value: Buffer): Buffer { return frame(msg(1, value)); }

test("Grok 官方 proto3 周额度：省略的零使用率等于剩余 100%，准确读取总量与周期", () => {
  for (const percent of [null, 0, 25.5, 100]) {
    assert.deepEqual(parseCredits(response(config(percent)), START), { usedPercent: percent ?? 0, periodStart: START, periodEnd: END });
  }
});

test("缺失或变化的协议不能冒充 100%，不扫描无关百分比", () => {
  assert.equal(parseCredits(response(config(null, false)), START).usedPercent, null);
  for (const percent of [NaN, Infinity, -1, 101]) assert.equal(parseCredits(response(config(percent)), START).usedPercent, null);
  assert.throws(() => parseCredits(frame(Buffer.alloc(0)), START), /config/);
  assert.throws(() => parseCredits(response(Buffer.alloc(0)), START), /周期/);
  assert.throws(() => parseCredits(response(Buffer.concat([config(null), int(1, 25)])), START), /字段类型/);
  assert.throws(() => parseCredits(response(Buffer.concat([config(null), float(1, 5), float(1, 8)])), START), /字段类型/);
  const monthly = msg(8, Buffer.concat([int(1, 1), msg(2, int(1, START / 1000)), msg(3, int(1, END / 1000))]));
  assert.throws(() => parseCredits(response(monthly), START), /不是.*周额度/);
});

test("截断帧、错误 trailer、错误 HTTP 不覆盖额度，429 保留 Retry-After", async () => {
  const good = response(config(null));
  assert.throws(() => parseCredits(good.subarray(0, -1), START), /截断/);
  assert.throws(() => parseCredits(Buffer.from([0, 0]), START), /帧头/);
  assert.throws(() => parseCredits(response(Buffer.from([13, 1])), START), /不完整/);
  const trailer = frame(Buffer.from("grpc-status: 8\r\n"), true);
  assert.throws(() => parseCredits(Buffer.concat([good, trailer]), START), (error: unknown) => error instanceof ProviderHttpError && error.status === 429);
  assert.deepEqual(parseCredits(Buffer.concat([good, frame(Buffer.from("grpc-status: 0\r\n"), true)]), START), parseCredits(good, START));
  await assert.rejects(fetchBilling("fake-test-token", START, undefined, async () => new Response("", { status: 429, headers: { "retry-after": "600" } })), (error: unknown) => error instanceof ProviderHttpError && error.status === 429 && error.retryAfterMs === 600_000);
  await assert.rejects(fetchBilling("fake-test-token", START, undefined, async () => new Response(new Uint8Array(good), { headers: { "grpc-status": "16" } })), /HTTP 401/);
});

test("Retry-After 支持秒数和 HTTP 日期，不接受无效值", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "45" }), START), 45_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(START + 60_000).toUTCString() }), START), 60_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "invalid" }), START), null);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "-1" }), START), null);
});
