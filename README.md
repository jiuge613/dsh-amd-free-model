<div align="center">

# dsh-amd-free-model

**简体中文** | [English](README_EN.md)

<img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
<img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
<img alt="适配内核" src="https://img.shields.io/badge/dsh-%3E%3D0.2.0-rc.2-2f6f4f?style=flat-square">
<img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

<div align="center">

> 在 DeepSeek Harness（dsh）里填**一个** AMD Radeon Token Factory API Key，
> 就能在模型选择器里用上 DeepSeek V4、MiMo V2.6、Qwen3.8、GLM 5.3 这些
> 跑在 AMD GPU Cloud 上的免费模型。
>
> *One AMD Radeon Token Factory API key, and the DeepSeek V4, MiMo V2.6,
> Qwen3.8 and GLM 5.3 fleet on the AMD GPU Cloud appears in the dsh model
> picker. Model directory and capabilities follow upstream; availability is
> measured from your own machine.*
>
> **每天自动探测一次** AMD 免费区有哪些模型；AMD 付费区的模型一律不接入。
>
> 纯插件挂载：不改内核、无构建步骤、零依赖。

</div>

---

## 亮点

- **只列免费模型，双重保险**——AMD 的 Token Factory 分两个区：免费的 `public_free`（"Public Free Model APIs"）和付费的 `dedicated`（"Deploy dedicated instances with your own credits"）。本插件只读免费区，且在解析任何卡片之前先断言分区是 `public_free`：遇到付费区或无法识别的分区，整份目录直接拒绝，不做"过滤"。此外每个模型的详情文档还要再判一次 `token_factory.section`，付费卡即使混进免费目录也会被剔除并在设置页列出被排除的 id。**收费的东西不可能出现在选择器里。**
- **每日探测，按需可调**——默认每 1440 分钟（一天）刷新一次目录：一次目录 POST、每模型一份详情、一次 Key 校验、每模型一次 ping。这个节奏对应的是"AMD 今天有哪些免费模型"——目录本身一周变不了几次，每 15 分钟轮询只是白花钱。觉得变化更快可在设置页改小。
- **一个 Key，模型即到**——设置页粘贴一次，Key 只保存在本机（`0600` 文件），API 只返回掩码形态，永不出现在任何响应里。
- **目录跟随上游**——模型集合、上下文长度、视觉/工具/思考能力每次刷新都从免费区目录重新拉取，不是写死的快照；目录接口**不需要 Key**，所以没填 Key 也能看到完整清单。
- **负载是负载，可用性是可用性**——每两分钟拉一次公开负载接口（空闲/繁忙/满载 + 利用率），作为徽章显示；一个 100% 满载的模型**不会**被移出选择器，可用性只由逐模型实测决定。
- **诚实的探测判定**——网关点名拒绝的模型才移出选择器；5xx、429、超时、断网一律不动它。没填 Key 时全部标记「待填 Key」并照常展示，绝不让选择器变空。
- **思考强度真实生效**——`Light / Balanced / Deep` 对应实际下发的 `max_tokens` 预算（2048 / 8192 / 模型容量），思考不可关的模型（MiMo V2.6）低档翻倍，因为思考与正文抢同一份额度。
- **本地转发端口**——OpenAI 兼容的 `127.0.0.1` 监听，让其它本地工具用一个 base URL + Key 调用这些模型；只绑回环，非回环地址直接拒绝。
- **应用内升级 + 热重载**——设置页一键升级（下载 → SHA-256 校验 → 备份 → 原子替换 → 回读 → 热重载，任一步失败自动回滚），升级与代码更新即时生效。
- **无浏览器界面也能跑**——只把 `llm` 当硬依赖；没有 web server 的 composition 里照样出模型，设置页路由挂在自己的 fiber 上待命。
- **用量看板，全部留在本机**——Token 热力图、总量曲线、输出速度与首字延迟逐次采样，不上传任何数据。
- **信任围栏**——插件的 HTTP 路由优先于内核 `/api` 分发，因此自带与内核一致的准入检查（composition 的 `connection` 服务，缺席时退回结构化围栏：仅回环、拒跨站、Host 缺失即拒）。

## 你会看到什么

**模型选择器**：`AMD Free Model` 分组，每行带能力描述（视觉/上下文/思考预算）。

**设置页 `设置 → AMD Free Model`**，七个分区：

1. **模型清单**——每模型的可用性徽章、负载徽章（空闲/繁忙/满载 + 利用率）、视觉/纯文本、上下文、最长输出、各思考档位实际上限、实测首字延迟，以及单次基准测试按钮。页首会显示"已排除 N 个收费模型"，被剔除的 id 悬停可见。
2. **API Key**——密码输入框、保存/清除、掩码状态与验证结果、去官方领取 Key 的链接。保存后立即用 `/v1/models` 验证并重跑全部探测。
3. **公告中心**——仓库推送的公告流：未读计数、单条/全部已读、系统通知开关。
4. **用量看板**——总览计数、17 周 Token 热力图、总量曲线、速度迷你图、按模型汇总表。
5. **本地转发**——开关、监听地址与端口、复制 base URL、显示/复制/轮换 Key、`curl` 示例。
6. **插件设置**——总开关、自动探测间隔（默认 1440 分钟 = 每日）、单次输出上限、Key 状态与最近探测时间。
7. **插件升级**——当前/最新版本、检查更新、一键升级、热重载按钮。

## 安装

```bash
dsh plugin --profile web add /绝对路径/dsh-amd-free-model
```

装完重启一次应用。`--profile` 填你实际使用的那个。

> **桌面端**不要用 `link:` 依赖安装（profile 闸门拒绝符号链接/junction，报 `PROFILE_UPGRADE_REQUIRED`）。用应用内插件管理器，或复制真实目录 + 在 `dependencies` 写版本号 + `dsh.profile.bundles` 追加包名——详见参照项目的安装文档。

### 配置 Key

1. 打开 [developer.amd.com.cn/radeon/profile](https://developer.amd.com.cn/radeon/profile) 登录并领取 API Key；
2. `设置 → AMD Free Model → API Key`，粘贴 → 保存；
3. 页面立即显示「Key 有效」，模型从「待填 Key」转为「可用」。

## 上游是哪些源

只有一个：**AMD Radeon Cloud Token Factory**（`developer.amd.com.cn`）。具体到代码（`src/upstream.js`，2026-09-29 实测）：

| 用途 | 目标 | 凭据 |
| --- | --- | --- |
| 对话请求 | `POST /radeon/api/v1/chat/completions` | `Authorization: Bearer <你的 Key>` |
| Key 验证与模型清单 | `GET /radeon/api/v1/models` | 同上 |
| **免费区**目录与能力 | `POST /radeon/api/tokenfactory/bootstrap`、`GET …/model?id=…` | 无（需 `Origin`+`Referer` 头，这是站点的 CSRF 检查） |
| 实时负载 | `GET /radeon/api/tokenfactory/load` | 无 |
| 公告与升级清单 | 本仓库 `feed/*.json`（raw.githubusercontent 优先，jsDelivr 兜底） | 无 |
| 出口 IP（转发诊断） | `api.ipify.org` 等，仅读出口地址 | 无 |

- **付费区（`/api/templates`，`token_factory.section: "dedicated"`）从不请求**：那是要扣账户 Credits 部署专用实例的目录，本插件不接入，README 列出的出网目标里也没有它。
- **没有中转、没有号池**：你的 prompt、工具结果与随附图片会作为正常推理请求直发 AMD 免费网关，与调用任何一家模型 API 没有区别。
- 用量看板、设置、Key 全部只落在本机 `DSH_HOME/amd-free-model/`。
- Key 在设置 API 中只以掩码形态返回（首 4 尾 4）；存储文件权限 `0600`。
- 应用内升级信任插件仓库本身——能推送仓库的人能推送任意代码，与「安装一个插件更新」的信任模型相同；文件完整性由 SHA-256 清单保障。

## 安全与隐私

- 所有状态写在 `DSH_HOME/amd-free-model/`：`settings.json`（含 Key，`0600`）、`stats.json`、`availability.json`、`catalog.json`。
- 转发监听**只绑回环**，无 Key 请求一律 `401`；把地址改成可路由接口会被直接拒绝。
- 转发 Key 由 `crypto` 运行时生成、`timingSafeEqual` 比对。本仓库不含任何硬编码凭据。
- 公告 HTML 在客户端经严格白名单渲染（脚本注入、事件属性、`javascript:` URL、iframe/svg/form 全部丢弃）。
- 卸载只需移除 bundle 条目；数据目录是纯 JSON，可直接删除。

## 开发

```bash
npm test                    # 全部离线套件 + 清单一致性检查，一条命令，不出网
npm run selftest            # 端到端：假网关 + 真插件，也不出网
npm run manifest            # 重新生成 feed/manifest.json
npm run manifest:check      # 校验清单与文件字节一致
```

`npm test` 包含五个套件：

- `scripts/offline-test.mjs`——目录投影与免费过滤、消息投影与工具配对修复、SSE 解码、预算档位、失败分类、信任围栏，32 条断言；
- `scripts/client-lint.mjs`——中英字典键集合双向一致、每个 `t()` 键存在、无死键、bundle id 与包名一致；
- `scripts/build-manifest.mjs --check`——清单与磁盘字节一致（LF 归一化，防 CRLF 漂移）；
- `scripts/host-selftest.mjs`——假 AMD 网关上的完整链路：付费卡被剔除、无 Key 冷启动、保存 Key、探测、六种流式路径、信任围栏、转发端口、基准测试，25 条断言；
- `scripts/section-gate-test.mjs`——独立进程里让网关回答付费分区，验证分区门禁在读任何卡片之前就拒绝：4 条断言（它必须独立进程，因为 AMD origin 是模块加载时的常量）。

免费过滤的三处防护都做过变异测试：把 `isFreeDetail` 改成恒真、让 `buildCatalog` 不剔除、让分区断言放行——每一种都会让离线套件变红。

需要 Node `^22.19.0 || >=24.0.0`。无安装步骤、无依赖。

## 内核适配

声明的内核范围是 **`>=0.2.0-rc.2 <0.3.0-0`**（`peerDependencies` 上 `@deepseek-ai/dsh-llm`，标记 optional）。范围不是猜的：

- rc.2 的 `llm.registerAdapter` 校验逻辑（`providerInfo` 必须保 id、name 非空）与本插件的实现一致；`prepareCall` / `listModels` / `resolveModel` / `imageRequestPricing` 契约在 rc.1 → rc.2 之间无变化。
- rc.2 的重试调度器（`@deepseek-ai/dsh-llm-retry`）从**顶层**读 `initialDelayMs` / `maxDelayMs` / `jitterRatio`（`config.initialDelayMs * 2 ** exponent`）。本插件的 `providerRetryPolicy()` 返回的就是扁平已解析策略——把退避字段嵌进 `backoff: {}` 会让每次延迟变成 `NaN`，而持久会话日志拒绝非有限数，一个本可恢复的瞬时故障就变成整轮报废。
- 插件只 import `@deepseek-ai/dsh-llm` 一处（`adapter/kernel.js`，取 attribution User-Agent，且失败降级为字面量），适配器本体是结构性的、不继承内核基类，因此不把版本钉死。

## 实现结构

```text
index.js          Host 半身：适配器注册、目录与探测循环、Key 存储与掩码、
                  webServer 路由、转发端口、公告/升级/热重载接线
adapter/          内核接缝：唯一允许 import @deepseek-ai/* 的地方
src/adapter.js    结构性 LlmAdapter：providerInfo、listModels、resolveModel、
                  prepareCall、stream、providerRetryPolicy
src/upstream.js   端点与鉴权：目录/负载/chat 三组 URL、站点头（CSRF）、Bearer 头
src/http.js       请求发送、按 body 形状嗅探（不信 Content-Type）、失败分类
src/catalog.js    目录投影：本地能力基线 + 发现文档合并 + 负载解析
src/probe.js      Key 验证（/v1/models）与逐模型 ping 探测，两问分开
src/messages.js   harness 消息 -> chat 线投影、工具调用配对修复
src/stream.js     SSE -> harness StreamChunk，usage 不相交计数
src/effort.js     思考档位 -> 真实下发的 max_tokens 预算
src/forward.js    独立的 OpenAI 兼容监听器（只绑回环）
src/trust.js      插件路由的请求信任围栏
src/store.js      自有 JSON 存储（0600、原子写）
src/feed.js       远程公告流；src/updater.js 应用内升级；src/reload.js 自热重载
client.js         浏览器半身：手写 ModuleLoader bundle，无构建步骤
scripts/          离线测试套件与发布清单生成器
```

### 三个值得知道的架构决定

- **结构性实现适配器，不 import `@deepseek-ai/dsh-llm`**。内核从不检查 `instanceof`，鸭子类型即可——同一份代码可以跨内核版本运行，依赖也不会被钉死。
- **目录发现不需要 Key**。Token Factory 的目录、能力与负载接口全部公开（目录 POST 只查 `Origin`/`Referer`），所以模型清单与能力卡片在没填 Key 时就完整可用；Key 只门禁「能不能真的调用」。
- **自己的 JSON 存储，而不是 settings seam**。settings 注册 API 在内核版本间不一致；私有 JSON 存储行为一致，且 Key 落在 `0600` 文件里，不进入任何共享设置文档。

## 关于 `dsh-our-free-model`

本项目的骨架、架构与大量工程细节（body 形状嗅探、工具配对修复、扁平重试策略、预算式思考档位、原子升级、信任围栏）源自 [zouyuxuan122/dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model)，依其 MIT 许可证使用，版权声明保留在 [LICENSE](LICENSE)。上游解决的是「免密 OpenAI 网关」，本项目解决的是「AMD Token Factory + 用户自有 Key」，探测、鉴权与目录层为重写。

本项目是独立插件，与 AMD 无隶属、认可或赞助关系。"AMD" 与 "Radeon" 为 AMD 的商标，此处仅用于指明所对接的服务。用你的 Key 访问免费额度受 AMD 自身条款约束。

## 许可证

MIT，见 [LICENSE](LICENSE)。
