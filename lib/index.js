/**
 * dsh-pi-thinking —— DSH（DeepSeek Harness）主机端插件
 *
 * 目标：让经由 llm-pi-ai 手工声明的第三方模型（OpenAI 兼容网关等）也能像官方
 * 模型一样调整思考强度（reasoning effort）。
 *
 * 原理（针对 DSH 0.1.7+ / 0.2.x 的声明式 volatile 配置模型）：
 * - llm-pi-ai 只对声明了 reasoningEfforts 能力表（档位 → 网关线值）的模型提供
 *   思考强度选择器，并在请求中按表发送对应线值；provider 级 reasoning 字段决定
 *   选择器的默认档。
 * - 本插件通过 configEditor 服务把「预设档位 + 线值映射 + provider 默认档」写入
 *   llm-pi-ai 的 providers（只增改 reasoning / reasoningEfforts，保留其它一切），
 *   适配器会在配置提交后立即（loader/volatile-update）重建路由与模型目录。
 * - 插件自身的所有配置字段均为 volatile，宿主根据 Config schema 自动渲染设置卡，
 *   修改后即时生效，无需重启。
 */

import z from "@deepseek-ai/schemastery";
import { isDeepStrictEqual } from "node:util";
import { LEVELS, computeEntryNext } from "./core.js";

export const name = "dsh-pi-thinking";
export const inject = ["configEditor"];

const PI_AI_ENTRY = "llm-pi-ai";
const PRESET_NAMES = Object.freeze(["official", "generic", "full"]);
const NullableLevel = z.union([z.const(null), ...LEVELS]);

/** 插件自身的设置卡 schema（全部 volatile → 宿主自动渲染并支持运行时修改）。 */
export const Config = z.object({
  /** 自动为未声明思考能力表的第三方模型补齐档位（默认开启）。 */
  autoFill: z.boolean().default(true).volatile(),
  /** 补齐时使用的预置档位集。 */
  preset: z.union(PRESET_NAMES).default("official").volatile(),
  /** 全局默认思考档（写入没有显式默认档的 provider；null = 不设置）。 */
  globalDefault: NullableLevel.default(null).volatile(),
  /** 档位 → 网关线值 的全局覆盖（如 high → "ultra"；空值 = 用档位名/不发送）。 */
  wireMap: z.dict(z.string()).default({}).volatile(),
  /** 按 provider / 模型 的细调。 */
  providers: z
    .dict(
      z.object({
        /** 该 provider 的默认思考档（覆盖全局默认；null = 不设置）。 */
        default: NullableLevel.default(null),
        /** 按模型 id 细调。 */
        models: z
          .dict(
            z.object({
              /** false = 明确标记为非思考模型（选择器只剩 Off）；true = 参与补齐。 */
              enabled: z.boolean().default(true),
              /** 该模型的档位 → 线值覆盖（优先级高于全局 wireMap）。 */
              wire: z.dict(z.string()).default({}),
            })
          )
          .default({}),
      })
    )
    .default({})
    .volatile(),
});

/**
 * 读取插件配置。DSH 0.2.x 的 volatile 字段在 apply 时是带 .get() 的引用对象，
 * 这里统一归一化为普通值，兼容旧版本（普通值直读）。
 */
function readConfig(config) {
  const value = (key, fallback) => {
    const field = config?.[key];
    if (
      field !== undefined &&
      field !== null &&
      typeof field === "object" &&
      typeof field.get === "function"
    ) {
      const current = field.get();
      return current ?? fallback;
    }
    return field ?? fallback;
  };
  return {
    autoFill: value("autoFill", true),
    preset: value("preset", "official"),
    globalDefault: value("globalDefault", null),
    wireMap: value("wireMap", {}),
    providers: value("providers", {}),
  };
}

export function apply(ctx, config) {
  const logger = ctx.logger;
  const timer = (fn, ms) => (typeof ctx.setTimeout === "function" ? ctx.setTimeout(fn, ms) : setTimeout(fn, ms));

  /** 把插件配置同步进 llm-pi-ai entry（只写差异，无变化则跳过）。 */
  const sync = async (reason, attempt = 0) => {
    const editor = ctx.get("configEditor");
    if (editor === void 0) {
      if (attempt < 4) return void timer(() => sync(reason, attempt + 1), 500);
      return void logger.warn(`${name}: configEditor 服务不可用，已放弃同步（${reason}）`);
    }

    let row;
    try {
      row = editor
        .configuration()
        .find((r) => r.entry?.options?.id === PI_AI_ENTRY);
    } catch (error) {
      logger.warn(`${name}: 读取 llm-pi-ai 配置失败（${reason}）: ${String(error)}`);
      return;
    }

    if (row === void 0 || row.entry === void 0) {
      if (attempt < 6) return void timer(() => sync(reason, attempt + 1), 800);
      return void logger.info(`${name}: 未找到 llm-pi-ai entry，跳过同步（${reason}）`);
    }

    try {
      const current = row.override ?? {};
      const next = computeEntryNext(current, readConfig(config));
      if (isDeepStrictEqual(next, current)) {
        logger.debug(`${name}: 配置无变化，跳过写入（${reason}）`);
        return;
      }
      await editor.edit(row.entry, (fresh) =>
        computeEntryNext(fresh ?? {}, readConfig(config))
      );
      const providerCount = Object.keys(next.providers ?? {}).length;
      logger.info(
        `${name}: 已同步思考强度配置到 llm-pi-ai（${reason}），涉及 ${providerCount} 个 provider`
      );
    } catch (error) {
      logger.warn(`${name}: 同步失败（${reason}）: ${error?.stack ?? String(error)}`);
    }
  };

  // 启动时同步（带重试）；之后响应自身配置修改与应用级配置重载。
  sync("启动");
  ctx.on("loader/volatile-update", () => sync("配置更新"));
  ctx.on("app-boot/config-reload", () => sync("配置重载"));
}
