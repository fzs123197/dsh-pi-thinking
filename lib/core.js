/**
 * dsh-pi-thinking —— 纯逻辑层（不依赖 DSH / Cordis 运行时可独立测试）
 *
 * 核心职责：
 * 1. 把「预设档位集 + 全局线值映射 + 模型级线值覆盖」编译成 llm-pi-ai 的
 *    reasoningEfforts 能力表（level → 网关实际发送的线值）。
 * 2. 在保留用户已有配置的前提下，计算 llm-pi-ai entry 的下一次 providers 配置：
 *    - 已显式声明 reasoningEfforts 的模型一律不动；
 *    - 未声明的模型按需补齐能力表（或标记为非思考模型）；
 *    - provider 级默认档（reasoning）只在有明确指令时写入，绝不覆盖用户已设值。
 */

/** pi-ai 支持的全部思考档位（升级顺序，与 dsh-llm-pi-ai 的 THINKING_LEVELS 一致）。 */
export const LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** 预置档位集：official=官方 DeepSeek 风格；generic=通用 OpenAI 兼容；full=全部档位。 */
export const PRESETS = Object.freeze({
  official: ["off", "high", "max"],
  generic: ["off", "low", "medium", "high"],
  full: [...LEVELS],
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析某一档位最终应发送的线值。
 * 优先级：模型级 wire > 全局 wireMap。空字符串 / 缺失视为「未映射」。
 */
export function resolveWire(level, modelWire, globalWire) {
  const candidates = [modelWire?.[level], globalWire?.[level]];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (trimmed === "") continue;
    return trimmed;
  }
  return undefined;
}

/**
 * 由预置档位集 + 线值映射编译成 reasoningEfforts 能力表。
 * - off：未映射 → null（合法：表示「选择 off 时不发送思考参数」）；
 * - 其余档位：未映射 → 使用档位名本身作为线值（如 high → "high"）。
 */
export function buildEffortsTable(preset, globalWire = {}, modelWire = {}) {
  const levels = PRESETS[preset] ?? PRESETS.official;
  const table = {};
  for (const level of levels) {
    const wire = resolveWire(level, modelWire, globalWire);
    if (level === "off") table.off = wire ?? null;
    else table[level] = wire ?? level;
  }
  return table;
}

/**
 * 计算下一次 providers 配置（纯函数，不改动入参）。
 *
 * @param {Record<string, any> | undefined} providers 当前用户层的 llm-pi-ai providers
 * @param {{
 *   autoFill?: boolean,
 *   preset?: keyof typeof PRESETS,
 *   globalDefault?: string | null,
 *   wireMap?: Record<string, string>,
 *   providers?: Record<string, {
 *     default?: string | null,
 *     models?: Record<string, { enabled?: boolean, wire?: Record<string, string> }>
 *   }>
 * }} cfg 插件自身的配置（已归一化为普通对象）
 * @returns {Record<string, any>} 完整 providers（未涉及的字段与顺序原样保留）
 */
export function computeProvidersNext(providers, cfg) {
  const autoFill = cfg.autoFill !== false;
  const preset = cfg.preset ?? "official";
  const globalDefault = cfg.globalDefault ?? null;
  const globalWire = isRecord(cfg.wireMap) ? cfg.wireMap : {};
  const providerCfg = isRecord(cfg.providers) ? cfg.providers : {};

  const next = {};
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    if (!isRecord(profile)) {
      next[provider] = profile;
      continue;
    }
    const pcfg = isRecord(providerCfg[provider]) ? providerCfg[provider] : {};
    const modelCfg = isRecord(pcfg.models) ? pcfg.models : {};

    // —— provider 级默认档：插件显式指令 > 全局默认 > 保留用户已设值 ——
    let reasoning = profile.reasoning;
    if (pcfg.default) reasoning = pcfg.default;
    else if (reasoning === undefined && globalDefault) reasoning = globalDefault;

    const patched = { ...profile };
    if (reasoning !== undefined) patched.reasoning = reasoning;

    // —— models[]：只补未声明能力表的模型 ——
    if (Array.isArray(profile.models)) {
      patched.models = profile.models.map((model) => {
        if (!isRecord(model)) return model;
        if (model.reasoningEfforts !== undefined) return model; // 已声明：不动
        const mcfg = modelCfg[model.id];
        if (mcfg?.enabled === false) return { ...model, reasoningEfforts: false };
        if (!autoFill) return model;
        return {
          ...model,
          reasoningEfforts: buildEffortsTable(
            preset,
            globalWire,
            isRecord(mcfg?.wire) ? mcfg.wire : {}
          ),
        };
      });
    }

    // —— modelOverrides：同样只补未声明的条目 ——
    if (isRecord(profile.modelOverrides)) {
      const overrides = {};
      for (const [modelId, override] of Object.entries(profile.modelOverrides)) {
        if (!isRecord(override) || override.reasoningEfforts !== undefined) {
          overrides[modelId] = override;
          continue;
        }
        const mcfg = modelCfg[modelId];
        if (mcfg?.enabled === false) {
          overrides[modelId] = { ...override, reasoningEfforts: false };
          continue;
        }
        if (!autoFill) {
          overrides[modelId] = override;
          continue;
        }
        overrides[modelId] = {
          ...override,
          reasoningEfforts: buildEffortsTable(
            preset,
            globalWire,
            isRecord(mcfg?.wire) ? mcfg.wire : {}
          ),
        };
      }
      patched.modelOverrides = overrides;
    }

    next[provider] = patched;
  }
  return next;
}

/**
 * 计算 llm-pi-ai entry 的完整下一次配置（保留所有其他顶层字段）。
 */
export function computeEntryNext(current, cfg) {
  const base = isRecord(current) ? current : {};
  return {
    ...base,
    providers: computeProvidersNext(base.providers, cfg),
  };
}
