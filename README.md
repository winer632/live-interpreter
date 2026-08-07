# 实时同声传译 · 中 ⇄ English

面对面会谈用的双向同声传译工具。你说中文，对方立刻听到英文语音并看到英文字幕；
对方说英文，你立刻听到中文语音并看到中文字幕。

支持两个后端，界面上可切换：

| 后端 | 模型 | 特点 |
|---|---|---|
| **火山引擎**（默认） | `gpt-realtime-translate` 的国内对手 · 同声传译 AST 2.0 | 国内直连、支付宝充值、`zhen` 单会话双向 |
| **OpenAI** | `gpt-realtime-translate` | 自动识别语种、需代理与境外信用卡 |

---

## 快速开始

```bash
cd ~/Desktop/voice
npm install          # 只需一次
npm start
```

浏览器打开 **http://localhost:5173**（建议 Chrome 或 Edge，回声消除效果最好），
点「开始传译」→ 允许麦克风 → 直接说话。

### 先验证一下

```bash
npm run check        # 检查当前后端的 Key 与网络
npm run demo         # 演示模式：不消耗额度，走一遍完整界面
node test-routing.mjs   # 自动化校验方向路由（需 demo 模式在跑）
node test-live.mjs      # 真实链路验证，会消耗几分钱额度
node test-live.mjs en   # 验证英译中方向
```

`test-live.mjs` 会用 macOS 的 `say` 合成语音喂进去，把返回的译音存成
`translated-zh.wav` / `translated-en.wav`，可以 `afplay` 直接听。

---

## 获取 Key

### 火山引擎（推荐，国内无摩擦）

1. [火山引擎控制台](https://console.volcengine.com) 注册 → 实名认证
2. 服务中心 → **豆包语音** → 开通「**同声传译**」
3. 控制台 API Key 管理 → 创建 → 复制
4. 粘贴进本程序设置面板，或写进 `config.json`

资源 ID 固定 `volc.service_type.10053`，已内置。按音频时长计费。

### OpenAI（备选）

> ⚠️ **ChatGPT Plus / Pro 会员额度不能用于 API**，两者计费完全独立。

1. [platform.openai.com](https://platform.openai.com) → Settings → Billing → 绑境外信用卡 → 充 $10
2. API keys → Create new secret key

费用 $0.034/分钟/会话，双向需两条会话 ≈ **$0.068/分钟**（1 小时约 $4）。

---

## 网络

- **火山**：`openspeech.bytedance.com` 国内直连，**默认不走代理**。
  若确实需要代理，设 `VOLC_USE_PROXY=1`。
- **OpenAI**：`api.openai.com` 通常需要代理，程序自动读取 `HTTPS_PROXY` / `ALL_PROXY`：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
npm start
```

代理必须支持 `CONNECT` 隧道，否则 WebSocket 建不起来。

---

## 使用说明

| 操作 | 说明 |
|---|---|
| **开始传译** | 建立上游会话并开启麦克风 |
| **中英自动** | 方向全自动识别，无需手动切换。按整句累计文本判定，中文里夹英文术语（"这是我们 SensePedia 的产品经理"）也不会判错 |
| **空格键** | 按住临时静音麦克风，松开恢复 |
| **⛶ 全屏** | 隐藏工具栏、字号放大，方便转屏给客户看 |
| **⚙ 设置** | 后端切换、两家的 Key、回声策略、扬声器音量 |

字幕排版：左栏中文、右栏英文。**灰色小字是原文，彩色大字是译文**。

---

## 术语库

产品名、公司名这类专有名词最容易被听错。实测 `SensePedia` 会被识别成
`SensePDU` 或 `SenseTimeedia`（模型往已知的 SenseTime 上靠）。

设置面板里可以填最多 **10 条**术语，每条两栏：

| 正确写法 | 常见误识（可选） |
|---|---|
| `SensePedia` | `SensePDU、SenseTimeedia` |

生效方式分两段，**这是实测出来的分工**：

1. **`hot_words_list`（火山侧）** —— 引导模型把音听对。
   实测 `SensePDU` → `Sense pedia`，音已经对了，**所以译音也念对了**。
2. **本地文字纠正** —— 把写法规范化成 `SensePedia`。

大小写和空格**自动收编**：填 `SensePedia` 就能同时改掉 `Sense pedia` /
`SENSE PEDIA` / `sense Pedia`。只有发音层面的误识才需要手工填进第二栏。
词边界有保护，`sensible pediatrics` 这类无关词不会被误伤。

> 火山文档的参数表里有个 `correct_words` 替换词字段，但**官方 proto 的 `Corpus`
> 消息里没有它**，protobuf 编码时会被静默丢弃 —— 实测无效。所以文字纠正是本地做的。

> OpenAI 端点官方明确不支持术语库（"No custom prompting or glossaries"），
> 切到 OpenAI 时只能纠正字幕文字，**改不了已经合成的语音**。

---

## 三个已知特性，会谈前请知悉

### 1. 首句译音约 2 秒才出来

实测火山首包延迟 **约 2.2–2.5 秒**。这不是卡顿——同传模型会**故意等足上下文**再开口，
否则会译出半截错句。字幕原文出现得更早（几百毫秒）。

### 2. 译音略长于原话，程序会自动追赶

合成语音时长约为源语音的 **1.2 倍**（含句间静音）。差值不大，但会累积，
所以程序做了两级补偿：

- 积压 > 1.5s 起逐级加快播放（最高 1.35 倍）
- 积压 > 8s 直接跳过重排

顶栏会显示「译音滞后 X.Xs」，超过 4 秒变黄。**看到持续变黄，就在句子之间多留点停顿。**

### 3. 回声/啸叫

同一房间外放时，扬声器的译音会被麦克风重新拾取。两个后端的防护强度不同：

- **OpenAI** 是双会话，有「播放期间冻结方向」这层保护，回环起不来 → 用「仅回声消除」即可
- **火山** 是 `zhen` 单会话双向，**没有这层保护** → 默认用「播放译音时压低麦克风」

万一还是循环，按顺序调整：

1. **把扬声器音量降到 60–70%** —— 最有效，先试这个
2. 回声处理改成「**播放译音时静音麦克风**」（绝不啸叫，代价是译音播放时对方插话会丢）
3. 终极方案：双方各配一副耳机，回环从物理上消失

---

## 结构

```
server.js                静态服务 + WebSocket 会话 + 配置/自检 API
backends/
  common.js              语种检测 · 方向路由 · 分句成行（两后端共用）
  volcengine.js          火山 AST 2.0，裸 protobuf over WebSocket
  openai.js              OpenAI 双会话 + 方向闸门
  mock.js                演示后端，不需要 Key
protos/                  火山官方 .proto（运行时由 protobufjs 加载）
public/                  前端：纯展示层
```

**方向路由和分句都在服务端**，前端只负责渲染，所以两个后端对前端长得完全一样：

```
{ t:'ready', backend, inputRate }
{ t:'dir',   dir }                        方向变化
{ t:'line',  id, dir, src, dst, final }   一整句的最新全量状态
{ t:'audio', pcm }                        译音，base64 PCM16 24kHz
{ t:'usage' | 'error' | 'closed', ... }
```

### 火山协议要点

来自官方 `protos.tar.gz` 与 `ast_python_client`（正文文档里没写帧格式）：

- WebSocket 消息体就是**裸 protobuf**，没有老 ASR/TTS 那套四字节帧头
- 新版控制台鉴权只需 `X-Api-Key` + `X-Api-Resource-Id`
- `source_language` 和 `target_language` **同时传 `zhen`** 即中英反转互译，一条会话双向
- 输入 16kHz/16bit/单声道 PCM，建议 80ms 一包；输出要 PCM 24kHz 浏览器才好直接播
- `651`/`654` 字幕是**增量**，`652`/`655` 是**整句全量**（实测确认）

调试时设 `DEBUG_VOLC=1` 可打印上游原始事件流。

---

## 其他

- Key 保存在 `config.json`（权限 600，已 gitignore）。也支持环境变量
  `VOLC_API_KEY` / `OPENAI_API_KEY`。
- 服务只监听 `127.0.0.1`，局域网访问不到。
- 换端口：`PORT=8080 npm start`
