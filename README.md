# dsh-persona-memory

给 [DSH](https://github.com/deepseek-ai/dsh) agent 的**跨会话长期记忆**：每次模型调用前，把「她是谁 + 她记得的事」压成一段 ≤900 字的卡片塞进系统提示；四个工具用来记、查、忘、看；每天自动衰减一次。

换会话、重启、上下文被压缩——人设和事实都还在。

```
## 你的长期记忆（跨会话，重启后还在）

你是小肥鱼，蓝毛，说话短，不用括号写动作。

- 【喜好】爸爸不喜欢别人叫他大佬
- 【约定】周末一起看《葬送的芙莉莲》
- 【事实】他在做抖音直播，内容是玩我的世界
- 【别碰】不要提他前女友

上面这些是背景，不用复述。要想起细节用 `memory_recall`；主人说了值得长期记住的事，用 `memory_remember` 记一条（一句话，别写成日记）。
```

## 它解决什么

| 问题 | 没有它 | 有它 |
|---|---|---|
| 换会话 | 新会话什么都不记得 | 卡片每轮重拼，人设 + 关键事实立刻回来 |
| 上下文压缩 | 细节被折掉就找不回 | 事实在 `facts.json` 里，随时 `memory_recall` |
| 记得太多 | 全塞进提示词，越聊越贵 | 卡片硬顶 900 字，其余按需检索 |
| 记得太久 | 过时的信息一直占位 | 按 tier 衰减，弱记忆自动归档（不删除） |

## 安装

需要一个能跑 DSH 插件的 profile（`~/.dsh/profiles/<名字>/`）。

**方式 A：从源码目录装**

```bash
# 1. 放进 profile 的插件目录（或者任意你喜欢的位置）
git clone https://github.com/ChencLi819/dsh-persona-memory.git \
  ~/.dsh/profiles/desktop/plugins/persona-memory

# 2. 让 profile 能解析到它：在 profile 的 package.json 里加一条
#    "dependencies": { "dsh-persona-memory": "file:./plugins/persona-memory" }
#    然后 pnpm install
```

**方式 B：从 npm 装（发布后）**

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-persona-memory
```

**然后在 `cordis.patch.yml` 里插一条：**

```yaml
- insert:
    - id: persona-memory
      name: dsh-persona-memory
      config:
        cardMaxChars: 900
```

重启 DSH。第一次启动会在数据目录生成 `facts.json` 和 `profile.example.md`（模板不会被读进提示词，想用就复制成 `profile.md` 再改）。

> 仓库自带 `cordis.patch.yml` 和 `package.json` 的 `dsh.bundle` 字段，所以用 DSH 的插件市场/本地 bundle 安装时可以直接识别。

## 工具

| 工具 | 干什么 | 例子 |
|---|---|---|
| `memory_remember` | 记一条长期信息（重复会自动合并） | 「爸爸不喜欢别人叫他大佬」，kind=preference，importance=0.9 |
| `memory_recall` | 查细节；不填 query 就按印象强度列 | query=「生日」 |
| `memory_forget` | 忘掉一条（归档，不是物理删除） | id=m0007 |
| `memory_status` | 看规模、分布、文件位置 | — |

写进系统提示的说明会引导模型：**背景不用复述，要细节才查；值得长期记住的才记，别记寒暄。**

## 命令

```
/memory                 状态
/memory card            看当前卡片（会塞进提示词的那段）
/memory search <词>     搜
/memory remember <一句话>
/memory forget <id>
/memory decay           手动跑一次衰减
/memory export          导出成 Markdown
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/persona-memory` | 数据目录；没有 `DSH_HOME` 时用 `~/.dsh/persona-memory` |
| `cardMaxChars` | `900` | 卡片字数上限。每步都会重发，别设太大 |
| `cardMaxFacts` | `14` | 卡片里最多几条事实 |
| `includeProfile` | `true` | 是否把 `profile.md` 放进卡片（最多占 40%） |
| `injectPrompt` | `true` | 关掉就只留工具，适合自己拼提示词 |
| `promptOrder` | `100` | 提示词段的排序，越小越靠前 |
| `autoDecay` | `true` | 每天第一次启动跑一次衰减 |

## 数据长什么样

```
<dataDir>/
├── profile.md            # 人设（人来写；模板见 profile.example.md）
├── facts.json            # 事实库
├── facts.archive.json    # 归档（目前只是占位，归档条目留在 facts.json 里带 status）
├── .state.json           # 上次衰减日期
└── profile.example.md    # 模板
```

`facts.json`：

```json
{
  "version": 1,
  "facts": [
    {
      "id": "m0001",
      "text": "爸爸不喜欢别人叫他大佬",
      "kind": "preference",
      "tags": ["称呼"],
      "importance": 0.9,
      "weight": 0.9,
      "tier": "core",
      "status": "active",
      "createdAt": 1762000000000,
      "updatedAt": 1762000000000,
      "lastMentionedAt": 1762000000000,
      "mentions": 1,
      "source": "agent"
    }
  ]
}
```

**`importance` vs `weight`**：`importance` 是这件事本身多重要（人定的，不变）；`weight` 是「现在还剩多少印象」，会随时间衰减、被提及时回涨。排序和归档都看 `weight`。

## 设计取舍

**为什么卡片只有 900 字？**
系统提示每一步都会重发。900 字是「够她知道你是谁、又不至于每步都烧钱」的折中。装不下的不丢，`memory_recall` 随时能查。

**为什么要衰减？**
不衰减的记忆库会变成垃圾场：三个月前的一句闲话和昨天的约定一样重。衰减只降权、不删除，低于 0.12 就归档，`/memory search` 仍可带 `includeArchived` 找回。

**为什么检索是词法的？**
零依赖、纯本地、可解释。中文用字符二元组 + BM25-lite，换一种说法就搜不到——这是上限，README 不粉饰。想要语义召回，两条路：
1. 给 `searchFacts` 加一个向量后端（`bge-small-zh` 之类），用 RRF 把两路结果融合；
2. 把 `text` 换成「一句话 + 关键词」的写法，让词法更容易命中。

**为什么合并规则这么保守？**
只合并「只差标点」或「短句几乎整句被长句包含」的两条。词法层面分不清「改写」和「另一件事」，宁可少合并，也别把两条记忆搅在一起。

## 迁移

从别的 `facts.json` 导入：

```bash
node scripts/import.mjs --from old-facts.json --data-dir ~/.dsh/persona-memory --dry
node scripts/import.mjs --from old-facts.json
```

支持的输入：数组，或 `{ facts: [...] }` / `{ items: [...] }`；字段 `text / kind / tags / importance|weight / tier / createdAt / lastMentionedAt`。

## 隐私

- 全部数据在本地，插件不发任何网络请求。
- 卡片会进入每次模型调用的系统提示——这是功能本身，但请知悉：写进 `profile.md` / `facts.json` 的内容会发给模型提供方。
- 想清除：停掉插件，删数据目录即可。

## 开发

```bash
npm test        # 单元测试（node:test，无依赖）
npm run smoke   # 用假宿主加载插件，跑一遍工具和命令
```

目录：

```
src/paths.mjs   路径 + 原子写
src/text.mjs    归一化 / 二元组 / Jaccard
src/store.mjs   事实库：写入合并、检索、衰减、统计
src/card.mjs    卡片与提示词段渲染
src/index.mjs   插件入口：提示词段 + 4 个工具 + /memory 命令
```

## Roadmap

- [ ] 语义检索后端（向量 + RRF）
- [ ] 换会话时自动生成 300 字交接摘要
- [ ] 事实之间的关联（`related: [id]`），检索时一跳扩散
- [ ] 导入/导出可视化

## English

`dsh-persona-memory` is a zero-dependency DSH plugin that gives an agent cross-session memory: a ≤900-character persona card injected into the system prompt, four tools (`memory_remember` / `memory_recall` / `memory_forget` / `memory_status`), and daily decay with archival. All data is local JSON/Markdown. Lexical search only (CJK bigrams + BM25-lite); pluggable embeddings are on the roadmap.

## License

MIT
