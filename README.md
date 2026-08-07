# 实时同声传译 · 中 ⇄ English / 日本語 · 粤语 → 普通话

面对面会谈用的实时传译工具。你说中文，对方立刻听到译文语音并看到译文字幕；
对方说英文或日语，你立刻听到中文语音并看到中文字幕。另有粤语转普通话字幕。

**语言对**（顶栏切换）

| | 双向？ | 有译音？ | 上游会话数 | 实现方式 |
|---|---|---|---|---|
| **中英自动** | ✅ | ✅ | 1 条 | 火山的 `zhen` 中英反转互译，一条会话包办双向，还能处理一句话里中英混杂 |
| **中日自动** | ✅ | ✅ | 2 条 | 火山没有 `zhja`，只能开 zh→ja 和 ja→zh 两条，靠方向闸门放行其一（费用约两倍） |
| **粤→普** | ❌ 单向 | ❌ 仅字幕 | 1 条 | 火山 s2s 里粤语两个方向的模型都不存在，只有 s2t 的 `yue-CN→zh` 可用 |

**后端**（设置面板切换）

| | 模型 | 特点 |
|---|---|---|
| **火山引擎**（默认） | 同声传译 AST 2.0 | 国内直连、支付宝充值、支持术语库、支持中日 |
| **OpenAI** | `gpt-realtime-translate` | 自动识别语种，需代理与境外信用卡，**只支持中英、不支持术语库** |

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
npm run check              # 检查当前后端的 Key 与网络
npm run demo               # 演示模式：不消耗额度，走一遍完整界面
node test-routing.mjs      # 自动化校验方向路由（需 demo 模式在跑）

node test-live.mjs         # 真实链路验证：中文 → 英文
node test-live.mjs en      # 英文 → 中文
node test-live.mjs ja      # 日语 → 中文（自动用中日语言对）
node test-live.mjs yue     # 粤语 → 普通话（仅字幕）
PAIR=zhja node test-live.mjs zh   # 中日语言对下说中文
node test-live.mjs zh "这是我们 SensePedia 的产品经理"   # 自定义文本
```

`test-live.mjs` 用 macOS 的 `say` 合成语音喂进去，把返回的译音存成
`translated-*.wav`，可以 `afplay` 直接听。

---

## 获取 Key

### 火山引擎（推荐，国内无摩擦）

1. [火山引擎控制台](https://console.volcengine.com) 注册 → 实名认证
2. 服务中心 → **豆包语音** → 开通「**同声传译**」
3. 控制台 API Key 管理 → 创建 → 复制
4. 粘贴进设置面板

资源 ID 固定 `volc.service_type.10053`，已内置。按音频时长计费。

在 <https://console.volcengine.com/speech/new/experience/translate?projectName=default>
页面可以看到火山引擎 token 余额。

### OpenAI（备选）

> ⚠️ **ChatGPT Plus / Pro 会员额度不能用于 API**，两者计费完全独立。

绑境外信用卡充值，$0.034/分钟/会话，双向需两条会话 ≈ **$0.068/分钟**。

---

## 网络

- **火山**：`openspeech.bytedance.com` 国内直连，**默认不走代理**。
  确需代理时设 `VOLC_USE_PROXY=1`。
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
| **中英自动 / 中日自动 / 粤→普** | 切换语言对。中英与中日的方向全自动识别；粤→普是单向且只有字幕 |
| **空格键** | 按住临时静音麦克风，松开恢复 |
| **⛶ 全屏** | 隐藏工具栏、字号放大，方便转屏给客户看 |
| **⚙ 设置** | 后端、术语库、两家的 Key、回声策略、扬声器音量 |

字幕排版：左右两栏随语言对变化（中文/粤语在左，译文语言在右）。灰色小字是原文，彩色大字是译文。
顶栏还会显示本次会话的累计用量和译音滞后秒数。

---

## 术语库

产品名、公司名最容易被听错。实测 `SensePedia` 会被识别成 `SensePDU` 或
`SenseTimeedia`（模型往已知的 SenseTime 上靠）。

设置面板里可填最多 **10 条**术语：

| 正确写法 | 常见误识（可选） |
|---|---|
| `SensePedia` | `SensePDU、SenseTimeedia` |

生效方式分两段，**这是实测出来的分工**：

1. **`hot_words_list`（火山侧）** —— 引导模型把音听对。
   实测 `SensePDU` → `Sense pedia`，音已经对了，**所以译音也念对了**。
2. **本地文字纠正** —— 把写法规范化成 `SensePedia`。

大小写和空格**自动收编**：填 `SensePedia` 就能同时改掉 `Sense pedia` /
`SENSE PEDIA`。只有发音层面的误识才需要手工填第二栏。词边界有保护，
`sensible pediatrics` 这类无关词不会被误伤。

---

## 三个已知特性，会谈前请知悉

### 1. 首句译音约 2 秒才出来

实测火山首包延迟 **2.2–2.5 秒**。这不是卡顿——同传模型会**故意等足上下文**再开口，
否则会译出半截错句。字幕原文出现得更早（几百毫秒）。

### 2. 译音略长于原话，程序会自动追赶

合成语音时长约为源语音的 **1.2 倍**。差值不大但会累积，所以做了两级补偿：

- 积压 > 1.5s 起逐级加快播放（最高 1.35 倍）
- 积压 > 8s 直接跳过重排

顶栏会显示「译音滞后 X.Xs」，超过 4 秒变黄。**持续变黄就在句子间多留停顿。**

### 3. 回声/啸叫

同一房间外放时，扬声器的译音会被麦克风重新拾取。两个后端的防护强度不同：

- **OpenAI** 是双会话，有「播放期间冻结方向」这层保护 → 用「仅回声消除」即可
- **火山中英** 是 `zhen` 单会话双向，**没有这层保护** → 默认用「播放译音时压低麦克风」

万一还是循环，按顺序调整：

1. **把扬声器音量降到 60–70%** —— 最有效，先试这个
2. 回声处理改成「**播放译音时静音麦克风**」（绝不啸叫，代价是译音播放时对方插话会丢）
3. 终极方案：双方各配一副耳机，回环从物理上消失

---

## 结构

```
server.js                静态服务 + WebSocket 会话 + 配置/自检 API
backends/
  common.js              语种检测 · 方向路由 · 分句成行 · 术语库编译（后端共用）
  volcengine.js          火山 AST 2.0，裸 protobuf over WebSocket，多会话
  openai.js              OpenAI 双会话 + 方向闸门
  mock.js                演示后端，不需要 Key
protos/                  火山官方 .proto（运行时由 protobufjs 加载）
public/                  前端：纯展示层
```

**方向路由、分句、术语纠正全在服务端**，前端只负责渲染，所以两个后端、
两个语言对对前端呈现的是同一套事件：

```
{ t:'ready', backend, pair, noAudio, inputRate }
{ t:'dir',   dir }                        方向变化，形如 zh2en / ja2zh
{ t:'line',  id, dir, src, dst, final }   一整句的最新全量状态
{ t:'audio', pcm }                        译音，base64 PCM16 24kHz
{ t:'usage' | 'error' | 'closed', ... }
```

语言对是**建连参数**（`/ws?pair=zhja`），切换必须重连——不同语言对的上游会话数和模式（s2s / s2t）都不一样。

---

## 踩坑记录

这些都是文档没写、或者写了但与实际不符的，实测确认后记在这里。

### 火山 AST

**帧格式**：WebSocket 消息体是**裸 protobuf**，没有老 ASR/TTS 那套四字节帧头。
文档正文没写，只能从附件 `protos.tar.gz` 和 `ast_python_client` 里看出来。

**译音是 float32 不是 int16**：文档在 `target_audio.rate` 的备注里藏了一句
"pcm 格式：16000Hz 下默认 16 位整型，**24000Hz 下默认 32 位浮点型**"。
按 int16 解读的话是一片噪声，且时长虚报一倍。代码里既显式声明了 `bits`，
接收端也做了 float32 自动识别兜底（float32 语音样本必落在 `[-1,1]`，
int16 数据按 float32 解读则指数位随机、绝大多数会变成 1e30 量级）。

**`correct_words` 是死字段**：参数表里写了替换词功能，但官方 proto 的 `Corpus`
消息里**没有这个字段**，protobuf 编码时被静默丢弃。文字纠正只能自己做。

**字幕增量语义**：`651`/`654` 是**增量片段**，`652`/`655` 是**整句全量**。

**计费字段是 PascalCase**：`BillingItem` 里是 `Unit` / `Quantity`，不是小写。

**ASR 不强制按声明的源语种识别**：中日双会话时，喂中文音频，两条会话都如实
转写出中文，其中 ja→zh 那条因为源语种==目标语种而原样透传。
这反而给出了干净的方向判据 —— 只看 ja→zh 那条的原文有没有假名。

**中日只能走声音复刻模式**：s2s 指定音色模式要求"目标语种必须为中英"，
传了 `speaker_id` 就输出不了日语。

**粤语的 s2s 模型压根不存在**：文档说粤语"仅支持作为源语种"，但实测比这更严格 ——
`StartSession` 会正常返回 150，一送音频才报
`InvalidData:group model:volc_tob-yue-CN2zh-s2s not found`，
反向 `zh2yue-CN` 同样不存在。**只有 s2t 的 `yue-CN→zh` 可用**，
所以粤普只能出字幕、且做不了反向。踩这个坑要靠实际送音频，光看握手结果会被骗。

**拿不到账户余额**：`UsageResponse` 只回本次消耗，余额要走另一套需 AK/SK
签名的 OpenAPI。所以界面显示的是"已用"而非"剩余"。余额请到
[控制台的同声传译体验页](https://console.volcengine.com/speech/new/experience/translate?projectName=default)
查看。

### 方向判定

必须按**整句累计文本**判，不能按单个增量片段判。"这是我们 SensePedia 的产品
经理"里的 `SensePedia` 片段不含汉字，单看它会把整句方向翻成英译中。

语种判别顺序：**假名 → 汉字 → 拉丁字母**。假名优先是因为日语句子几乎必然含
假名而中文永远不含；汉字优先于拉丁字母是因为中文夹英文术语是常态，按字符
比例算很容易误判。

### OpenAI

**握手成功不代表 Key 有效**：Key 无效时上游会先回 `101`，再推一条 error 事件
并以 close code `3000` 断开。自检必须等这条消息。

**不支持术语库**：官方文档明确 "No custom prompting or glossaries"。

---

## 其他

- Key 保存在 `config.json`（权限 600，已 gitignore）。也支持环境变量
  `VOLC_API_KEY` / `OPENAI_API_KEY`。
- 服务只监听 `127.0.0.1`，局域网访问不到。
- 换端口：`PORT=8080 npm start`
- 调试火山上游事件流：`DEBUG_VOLC=1 npm start`
