# dsh-token-safety

> 面向 [DeepSeek Harness (DSH)](https://github.com/your/du-hendeepseek-harness) 的宿主插件：**在模型调用前拦截用户消息，检测并修复 tokenizer 盲区** —— 也就是 token 切分把精确信息弄丢、导致模型答错的场景。只在真正命中盲区时才注入一小段精确结论，其余时候零开销、省 token。

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [怎么工作](#怎么工作)
- [覆盖的 4 类盲区](#覆盖的-4-类盲区)
- [配置](#配置)
- [注入格式](#注入格式)
- [性能与缓存](#性能与缓存)
- [兼容性与依赖](#兼容性与依赖)
- [开发与发布](#开发与发布)
- [License](#license)

---

## 它解决什么问题

大模型对"精确计数、精确比较、精确结构"这类问题经常翻车。一个常见原因：**tokenizer 切分把字符边界弄模糊了**，模型看到的不是完整字符序列，于是数错 `r`、比错 `9.9 > 9.11`、看错回文。

这个插件不猜、不算概率，而是**用本地精确计算给出确定结论**，当作参考事实喂给模型：

```
用户：strawberry 里有几个 r？
模型收到：[精确验证参考] r@3,8,9 (共3个)
```

模型看到这个参考后，回答就有据可依，不再靠 token 断片的猜。

关键设计原则：**只在命中盲区才注入**。普通消息一个字符都不加。

---

## 安装

需要 **DSH ≥ 0.1.1-rc.2**、**Node ≥ 22.19（或 ≥ 24）**。

### 从 GitHub

```bash
dsh plugin add github:zhaosihao2016/dsh_zhaosihao
```

### 从本地 bundle 目录（开发/内测）

```bash
# 在插件根目录上一级
dsh plugin add ./dsh-token-safety
```

装完**重启 DeepSeek Harness** 后生效。

---

## 怎么工作

插件注册了 DSH 的 `agent/pre-step` 事件（waterfall 模式）。模型要发请求前，会先经过这个钩子：

1. **轻量触发**：对即将进入 step 的**最后一条** user 消息跑正则/关键词。没命中 → 直接放行，一个字符都不加，近乎零开销。
2. **精确分析**：命中盲区才跑精确计算（计数、定点比较、结构判定）。
3. **紧凑注入**：把结论以 `[精确验证参考] …` 追加到那条用户消息末尾。只给结论，不给推导过程。
4. **LRU 缓存**：同一个字符串再次出现直接复用结果，不重算。

历史消息不动 —— 只检查并注入当前这条新输入，避免反复注入、浪费 token。

---

## 覆盖的 4 类盲区

| 类别 | 触发例子 | 注入结论 |
|---|---|---|
| ① 字符 / 子串计数 | `how many r in strawberry`<br>`apple 里有几个 p` | `r@3,8,9 (共3个)` |
| ② 数值比较 | `9.11 vs 9.9`<br>`v1.2 vs v1.10`<br>`123456789 vs 987654321` | `9.9>9.11` |
| ③ 文本结构 | 第 N 个字符 / 回文 / 单词数 | `第5个字符=d；是回文；共4个单词` |
| ④ 特殊格式 | Base64 / URL / 代码块 | `[Base64 len=28]；[URL 5段]；[代码块python]` |

### ② 数值比较的精度说明

比较用 **BigInt 定点缩放**实现，而不是 JS 的 `Number` 浮点：

- `9.11 vs 9.9` → `9.9>9.11`（浮点下 `9.9` 和 `9.11` 很容易被截断搞错）
- 大整数不受 `Number.MAX_SAFE_INTEGER` 限制
- 版本号按"点分段后的数值"逐段精确比较

结论统一输出为 **大数 > 小数**（或相等时 `==`）。

---

## 配置

插件导出了 `Config` schema（依赖可选的 `@deepseek-ai/schemastery`）。在 DSH 设置页能直接改开关；也可在 `cordis.patch.yml` 的插件行 `config:` 里写：

```yaml
- id: dsh-token-safety
  name: dsh-token-safety
  config:
    enabled: true           # 总开关
    charCount: true         # ① 字符/子串计数
    numericComparison: true # ② 数值比较
    textStructure: true     # ③ 文本结构
    specialFormat: true     # ④ 特殊格式
    maxCache: 512           # LRU 缓存条目上限
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉 = 插件完全旁路，零介入 |
| `charCount` | boolean | `true` | 字符/子串计数检测 |
| `numericComparison` | boolean | `true` | 数值/版本/大整数比较 |
| `textStructure` | boolean | `true` | 第N字符/回文/单词数 |
| `specialFormat` | boolean | `true` | Base64/URL/代码块标注 |
| `maxCache` | number | `512` | LRU 上限，防内存无限增长 |

---

## 注入格式

追加到**最后一条** user 消息的文本末尾，形如：

```
\n\n[精确验证参考] <结论1>；<结论2>；…
```

多条盲区命中用中文分号 `；` 拼接，一条消息里最多一条完整注入，紧凑不啰嗦。若消息 content 是数组（多 content block），则新增一个 text block 挂在末尾。

---

## 性能与缓存

- **命中前零开销**：只跑几次廉价正则。只有触发词出现才进入分析。
- **LRU 缓存**：默认 512 条。同字符串重复出现直接 `get` 复用，连正则都不重跑。
- **长度护栏**：单条消息文本超过 20000 字符直接跳过（不再扫描），避免大 payload 拖慢。
- 注入文本极短（一条结论通常 < 40 字节）。

---

## 兼容性与依赖

- 可选依赖：`@deepseek-ai/schemastery` —— **仅**用于渲染设置页的 `Config` schema。缺失时插件照常加载（`Config` 置 `null`），配置仍走 `config:`，功能完全不受影响。
- 宿主事件：`agent/pre-step`（DSH Host，waterfall）。已在 profile bundle `dsh-thinking-levels` / `dsh-vision-router` 同款事件上验证模式可用。

---

## 开发与发布

```bash
# 语法自检
node --check lib/index.js lib/detectors.js

# 检测器单测（直接跑）
node --input-type=module -e "
  import { detectCharCount } from './lib/detectors.js';
  console.log(detectCharCount('how many r in strawberry')); // r@3,8,9 (共3个)
"

# 发 GitHub（需先建好远程仓库并 git push）
dsh plugin add github:zhaosihao2016/dsh_zhaosihao
```

## 目录

```
dsh-token-safety/
├─ lib/
│  ├─ detectors.js   # 4 类盲区检测器（纯函数，可单测）
│  └─ index.js       # agent/pre-step 钩子、缓存、注入、Config schema
├─ cordis.patch.yml  # 插件行注册（insert）
├─ dsh.plugin.json   # DSH 插件元数据
├─ package.json
├─ README.md
└─ LICENSE           # MIT
```

---

## License

[MIT](./LICENSE)