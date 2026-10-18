# dsh-pi-thinking

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）经 **`llm-pi-ai`** 手工声明的第三方模型（OpenAI 兼容网关、本地推理服务等）**自动补齐思考强度（reasoning effort）档位**，并统一管理 provider 默认档与网关线值，让第三方模型也能像官方模型一样在 Composer 里调整思考强度。

- 自动为未声明 `reasoningEfforts` 的第三方模型补齐能力表 → 官方模型选择器立即出现思考强度档位
- 支持三种预置档位集：`official`（Off/High/Max）、`generic`（Off/Low/Medium/High）、`full`（全部 7 档）
- 支持把 DSH 档位映射为网关自定义线值（如 `high → ultra`、`max → max`）
- 支持 provider 级默认思考档（写入 `llm-pi-ai.providers.<p>.reasoning`，作为选择器默认档）
- 已显式声明的模型 / 用户已设置的默认档一律不被覆盖
- 所有配置走插件自身设置卡（volatile 声明式配置），设置卡内修改即时生效，无需重启

## 原理（为什么需要它）

`llm-pi-ai` 适配器只对声明了 **`reasoningEfforts` 能力表**（档位 → 网关实际发送的线值）的模型提供思考强度选择器，并在请求中按表发送对应参数。手工声明的第三方模型往往没有声明该表，因此选择器不出现、请求也无法带思考强度。

本插件在 `llm-pi-ai` 的 `providers` 配置上做两件事（其余字段原样保留）：

```yaml
# llm-pi-ai.providers.<provider>.reasoning          → provider 默认思考档（选择器默认）
# llm-pi-ai.providers.<provider>.models[].reasoningEfforts → 能力表，例如
reasoningEfforts:
  off: null     # 选择 off 时不发送思考参数
  low: "low"
  medium: "medium"
  high: "ultra" # 网关自定义线值
```

写入通过 `configEditor` 服务完成，`llm-pi-ai` 收到 `loader/volatile-update` 后即时重建路由与模型目录，无需重启。

## 安装

要求：DSH ≥ 0.1.7-rc.1（0.2.x 已验证），Node ≥ 18。

```sh
# 1. 获取源码（已 clone 则跳过）
git clone https://github.com/fzs123197/dsh-pi-thinking.git
cd dsh-pi-thinking

# 2. 安装依赖（pnpm 以 link: 方式链接本地目录时不会自动安装插件自身依赖）
npm install --no-audit --no-fund

# 3. 安装进目标 profile（以 web 为例）
dsh plugin --profile web add .

# 发布到 npm 后的标准安装（依赖自动随包安装）：
# dsh plugin --profile web add dsh-pi-thinking
```

安装输出应看到 `dsh-pi-thinking` 被加入 `dsh.profile.bundles`；若没有，请把插件加入 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-pi-thinking
      name: dsh-pi-thinking
```

重启 `dsh web`，进入 **设置 → 插件**，会看到 `dsh-pi-thinking` 的设置卡。

## 使用

### 设置卡字段

| 字段 | 说明 |
| --- | --- |
| `autoFill` | 自动为未声明能力表的模型补齐档位（默认开）。关闭后仅按 `providers` 明细处理 |
| `preset` | 补齐用的预置档位集：`official` / `generic` / `full` |
| `globalDefault` | 全局默认思考档；写入没有显式默认档的 provider；`null` = 不设置 |
| `wireMap` | 档位 → 网关线值 全局覆盖。空值 = 用档位名（`off` = 不发送） |
| `providers.<p>.default` | 该 provider 的默认思考档（覆盖全局默认） |
| `providers.<p>.models.<id>.enabled` | `false` = 明确标记为非思考模型（选择器只剩 Off） |
| `providers.<p>.models.<id>.wire` | 该模型的档位 → 线值覆盖（优先于全局 `wireMap`） |

### 等价 YAML 示例（写在 profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-pi-thinking
  config:
    autoFill: true
    preset: generic            # Off / Low / Medium / High
    globalDefault: high        # 没有显式默认档的 provider 默认 high
    wireMap:
      high: ultra              # 选择 High 时网关收到 reasoning_effort=ultra
    providers:
      qwen-gateway:
        default: high
        models:
          qwen3-8b:
            wire:
              max: extreme     # 仅该模型：max → extreme
          qwen3-8b-nothink:
            enabled: false     # 该模型明确不思考
```

### 效果

- 返回 Composer，选择已配置的第三方模型，模型选择器会出现思考强度档位（Low/Medium/High…）
- 官方「设置 → 模型」页也会同步显示这些能力表，可直接二次编辑
- 请求实际发送的线值 = 档位对应的 wire（未映射时用档位名），`off` 不发送思考参数

## 兼容性

- DSH `0.1.7-rc.1` 起的声明式 volatile 配置模型；`0.2.0-rc.x` 已验证
- 依赖服务：`configEditor`（`@deepseek-ai/dsh-config-editor`，`dsh-base` 自带）
- 目标模型：`llm-pi-ai` 下 `models[]` 或 `modelOverrides` 声明的第三方模型
- 官方 DeepSeek 模型（`llm-deepseek` 路由）不受影响，无需本插件

## 验证记录

以下在隔离 profile（dsh 0.2.0-rc.2）中实测通过：

1. 插件安装后自动进入 `dsh.profile.bundles`，启动无导入错误
2. 对未声明 `reasoningEfforts` 的第三方模型（`openai-completions` 路由）自动写入能力表
   `{off: null, high: high, max: max}`（official 预设），且 `api/baseURL/apiKeyEnv/models`
   等其它字段原样保留
3. 设置 `globalDefault: medium` 后重启，provider 自动获得 `reasoning: medium`
4. 已显式声明的模型与用户已设的 `reasoning` 不被覆盖（单元测试覆盖）
5. 纯逻辑单元测试 18 项全部通过（`npm test`）

## 注意事项

- **已声明的模型不动**：任何已带 `reasoningEfforts` 的模型、任何已带 `reasoning` 的 provider 都不会被本插件覆盖
- **`off` 语义**：默认 `off: null`，即选择 Off 时不发送思考参数；如果你的网关接受字符串 `off`，可在 `wireMap` 里映射 `off: off`
- **非思考模型**：确无思考能力的模型请在插件卡里把该模型 `enabled` 设为 `false`（等价于 `reasoningEfforts: false`），避免把思考参数发给不支持的网关
- **线值因网关而异**：OpenAI 系通常接受 `low/medium/high`，部分网关（如 Qwen 系）使用 `ultra/extreme` 等自定义值，请按网关文档在 `wireMap` 中配置
- **生效方式**：在插件设置卡中修改配置会经设置服务写入并触发同步，即时生效；若直接手工编辑 profile 的 `cordis.patch.yml`，请重启 `dsh web` 生效

## 开发

```sh
npm test   # node --test，纯逻辑单测
```

## License

MIT
