import test from "node:test";
import assert from "node:assert/strict";
import {
  LEVELS,
  PRESETS,
  buildEffortsTable,
  computeEntryNext,
  computeProvidersNext,
  resolveWire,
} from "../lib/core.js";

test("LEVELS 与预置档位集", () => {
  assert.deepEqual(LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(PRESETS.official, ["off", "high", "max"]);
  assert.deepEqual(PRESETS.generic, ["off", "low", "medium", "high"]);
  assert.deepEqual(PRESETS.full, LEVELS);
});

test("buildEffortsTable：official 预设默认线值", () => {
  const table = buildEffortsTable("official");
  assert.deepEqual(table, { off: null, high: "high", max: "max" });
});

test("buildEffortsTable：generic 预设默认线值", () => {
  const table = buildEffortsTable("generic");
  assert.deepEqual(table, { off: null, low: "low", medium: "medium", high: "high" });
});

test("buildEffortsTable：全局 wireMap 覆盖线值（如 high → ultra）", () => {
  const table = buildEffortsTable("official", { high: "ultra" });
  assert.equal(table.high, "ultra");
  assert.equal(table.max, "max");
  assert.equal(table.off, null);
});

test("buildEffortsTable：off 映射为字符串时原样发送", () => {
  const table = buildEffortsTable("official", { off: "off" });
  assert.equal(table.off, "off");
});

test("buildEffortsTable：模型级 wire 优先级高于全局 wireMap", () => {
  const table = buildEffortsTable("official", { high: "ultra" }, { high: "extreme" });
  assert.equal(table.high, "extreme");
});

test("resolveWire：空字符串视为未映射", () => {
  assert.equal(resolveWire("high", { high: "" }, { high: "ultra" }), "ultra");
  assert.equal(resolveWire("high", undefined, {}), undefined);
});

test("computeProvidersNext：为未声明能力表的模型补齐，保留其它字段", () => {
  const providers = {
    local: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "PI_TEST_KEY",
      models: [{ id: "qwen3-8b", name: "Qwen3 8B", contextWindow: 32768 }],
    },
  };
  const next = computeProvidersNext(providers, { preset: "generic" });
  const model = next.local.models[0];
  assert.deepEqual(model.reasoningEfforts, {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
  });
  assert.equal(model.id, "qwen3-8b");
  assert.equal(model.name, "Qwen3 8B");
  assert.equal(model.contextWindow, 32768);
  assert.equal(next.local.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(next.local.api, "openai-completions");
});

test("computeProvidersNext：已显式声明的模型不动", () => {
  const providers = {
    local: {
      models: [
        {
          id: "custom",
          reasoningEfforts: { off: null, high: "ultra", max: "max" },
        },
        { id: "plain" },
      ],
    },
  };
  const next = computeProvidersNext(providers, { preset: "official" });
  assert.deepEqual(next.local.models[0].reasoningEfforts, {
    off: null,
    high: "ultra",
    max: "max",
  });
  assert.deepEqual(next.local.models[1].reasoningEfforts, {
    off: null,
    high: "high",
    max: "max",
  });
});

test("computeProvidersNext：enabled=false 标记为非思考模型（false）", () => {
  const providers = { local: { models: [{ id: "no-think" }] } };
  const next = computeProvidersNext(providers, {
    preset: "official",
    providers: { local: { models: { "no-think": { enabled: false } } } },
  });
  assert.equal(next.local.models[0].reasoningEfforts, false);
});

test("computeProvidersNext：autoFill=false 且无模型配置 → 不补齐", () => {
  const providers = { local: { models: [{ id: "plain" }] } };
  const next = computeProvidersNext(providers, { autoFill: false, preset: "official" });
  assert.equal("reasoningEfforts" in next.local.models[0], false);
});

test("computeProvidersNext：provider 默认档写入 reasoning；不覆盖用户已设值", () => {
  const providers = {
    a: { models: [{ id: "m1" }] },
    b: { models: [{ id: "m2" }], reasoning: "low" },
  };
  const next = computeProvidersNext(providers, {
    preset: "generic",
    globalDefault: "medium",
  });
  assert.equal(next.a.reasoning, "medium");
  assert.equal(next.b.reasoning, "low"); // 用户已设值保留
});

test("computeProvidersNext：插件显式 provider 默认 > 全局默认", () => {
  const providers = { a: { models: [{ id: "m1" }] } };
  const next = computeProvidersNext(providers, {
    globalDefault: "low",
    providers: { a: { default: "max" } },
  });
  assert.equal(next.a.reasoning, "max");
});

test("computeProvidersNext：globalDefault 为空时不清空用户已设值", () => {
  const providers = { a: { reasoning: "high", models: [{ id: "m1" }] } };
  const next = computeProvidersNext(providers, {});
  assert.equal(next.a.reasoning, "high");
});

test("computeProvidersNext：modelOverrides 同样补齐", () => {
  const providers = {
    local: { modelOverrides: { qwen3: { contextWindow: 65536 } } },
  };
  const next = computeProvidersNext(providers, { preset: "official" });
  assert.deepEqual(next.local.modelOverrides.qwen3.reasoningEfforts, {
    off: null,
    high: "high",
    max: "max",
  });
  assert.equal(next.local.modelOverrides.qwen3.contextWindow, 65536);
});

test("computeProvidersNext：空/非法输入安全", () => {
  assert.deepEqual(computeProvidersNext(undefined, {}), {});
  assert.deepEqual(computeProvidersNext(null, {}), {});
  assert.deepEqual(computeProvidersNext({}, {}), {});
});

test("computeEntryNext：保留 providers 之外的其它顶层字段", () => {
  const current = { providers: { a: { models: [{ id: "m1" }] } }, future: { x: 1 } };
  const next = computeEntryNext(current, { preset: "generic" });
  assert.deepEqual(next.future, { x: 1 });
  assert.ok(next.providers.a.models[0].reasoningEfforts);
});

test("computeEntryNext：完整往返（用户层已是目标值 → 结果一致）", () => {
  const current = computeEntryNext({}, { preset: "official" });
  const again = computeEntryNext(current, { preset: "official" });
  assert.deepEqual(again, current);
});
