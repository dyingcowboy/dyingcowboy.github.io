---
title: "从 SwiGLU 到 RoPE：公式、张量形状与代码"
date: 2026-09-10
description: "把 SwiGLU 与 RoPE 的公式落实到 PyTorch 模块、Tensor 形状、缓存、广播与旋转代码。"
tags:
  - "CS336"
  - "Transformer"
  - "SwiGLU"
  - "RoPE"
draft: false
---

记录日期：2026-09-10。接续 [从文本到 RMSNorm](/notes/01-tokenizer-to-rmsnorm/)。依据本地 CS336 Assignment 1 §3.4.2–3.4.3、本次讨论和当前实现整理；解释性例子用于建立公式与代码的对应关系。

## 1. 当前完成情况

- SwiGLU 实现：类名为 `GatedFeatures`，已接入 adapter；本次会话实际运行对应测试通过。
- RoPE 实现：已完成频率、角度表、缓存、位置索引和旋转，已接入 adapter；用户报告独立 RoPE 测试通过。
- 测试入口：adapter 负责将测试参数转交给实现，测试命令不是直接运行这个文件。

```bash
uv run pytest tests/test_model.py::test_swiglu
uv run pytest tests/test_model.py::test_rope
```

这些是对应功能的验证，不意味着多头 attention 或完整 Transformer 已实现、已验证。

## 2. SwiGLU：双分支门控的 FFN

FFN 对每个 token 的向量独立做同一个可学习的非线性变换，位置之间共享参数，不直接混合不同位置。普通两层线性变换若没有中间非线性，可以合并为一层：`W2(W1 x) = (W2 W1)x`。

本作业的 SwiGLU 使用列向量记法：

\[
\operatorname{FFN}(x)=W_2\bigl(\operatorname{SiLU}(W_1x)\odot W_3x\bigr),
\qquad \operatorname{SiLU}(z)=z\sigma(z).
\]

`⊙` 是逐元素乘法；SiLU 与 sigmoid 不相同，前者还要乘上原来的 `z`。SiLU 的输出不是限制在 `[0,1]` 的概率开关，可以为负，也可以大于 1。

令 `D = d_model`，`H = d_ff`：

| 代码中的子层 | 构造方式 | 权重 | 输出形状 |
| --- | --- | --- | --- |
| `gate` | `Linear(D, H)` | W1：`[H, D]` | `[..., H]`，再经过 SiLU |
| `value` | `Linear(D, H)` | W3：`[H, D]` | `[..., H]` |
| `output` | `Linear(H, D)` | W2：`[D, H]` | `[..., D]` |

```python
z = self.gate(x)
gate = z * torch.sigmoid(z)
value = self.value(x)
return self.output(gate * value)
```

例如输入 `[2, 3, 4]`、中间维度为 8，两条分支都输出 `[2, 3, 8]`，相乘后仍是此形状，最后投影回 `[2, 3, 4]`。这是先升维、再降维；SiLU 本身不改变形状。

中间宽度约 `8D/3` 的原因是参数量匹配：普通宽度 `4D` 的两矩阵 FFN 约有 `8D²` 个参数，SwiGLU 三矩阵约有 `3DH` 个参数。作业配置中将宽度调整为附近的 64 的倍数；adapter 已给定 `d_ff` 时直接遵循传入维度。

SwiGLU 内部不负责 RMSNorm 和残差。外层 Transformer block 才组织 `x + FFN(RMSNorm(x))`。

### 本次实际犯过的错误

- **构造参数与权重形状混淆**：`Linear(in, out)` 创建 `[out, in]` 的权重，内部计算 `X @ W.T`，不能因为转置而交换构造参数。
- **W2、W3 装反**：W1、W3 是两条输入分支，W2 是最后输出层；编号不等于执行顺序。
- **sigmoid 当成 SiLU**：需要 `z * sigmoid(z)`。
- **类型标注缺少导入**：使用 `Float[Tensor, ...]` 需要导入 `jaxtyping.Float`。
- **adapter 未实现**：`NotImplementedError` 表示测试尚未进入自己的计算，不能据此判断公式正确与否。

当前代码仍通过 `.data = ...` 加载权重。这能替换实际权重形状，曾掩盖构造方向错误；后续整理时宜沿用 Linear adapter 的 `torch.no_grad()` 与 `weight.copy_(...)`，并核对源、目标形状。

## 3. nn.Module、参数与缓存

`nn.Module` 是组织神经网络计算、统一管理状态的基类，不等于“一张可学习权重”。

| 对象 | 作用 | 注册方式 |
| --- | --- | --- |
| Parameter | 可学习参数，例如 RMSNorm 的缩放权重 | `self.weight = nn.Parameter(...)` |
| 子模块 | 组合计算，例如 SwiGLU 的 Linear | `self.gate = Linear(...)` |
| Buffer | 非参数状态，例如 RoPE 的 sin/cos 表 | `self.register_buffer(...)` |

`__init__` 创建持久状态；`forward` 使用已有状态计算。`layer(x)` 经 Module 调用机制执行 `forward`。Module 能递归收集参数、迁移参数和 buffer、保存状态；autograd 根据 Tensor 运算计算梯度，优化器更新参数。

`d_ff: int` 中的 `d_ff` 是维度配置整数，不是输入 Tensor；类型标注也不会自动转换类型。`self.gate` 是模块，`self.gate(x)` 才是计算结果 Tensor。

**缓存就是保存已算出的结果，以后直接取用。** RoPE 的旋转系数只取决于固定配置与位置，不依赖 q、k 的内容，所以可以复用：

```python
self.register_buffer("cos_cache", torch.cos(angles), persistent=False)
self.register_buffer("sin_cache", torch.sin(angles), persistent=False)
```

- 字符串决定属性名；`cos_cache`、`sin_cache` 是自定义名称，不是特殊关键字。
- 注册后可以通过 `self.cos_cache` 访问，并随模块 `.to(device)` 迁移。
- `persistent=False` 仅表示不写入 `state_dict`，不表示 forward 后删除缓存。
- 普通 `self.cache = tensor` 不会自动注册为 buffer。
- 缓存不是数学必需条件：也可每次现算，但缓存以存储空间换取减少重复计算。生成 sin/cos 后不必长期保留角度表。

## 4. Tensor 的轴与数学向量

一维 Tensor 常用来表示向量，但两种“维数”含义不同：`shape=[3]` 是有一条索引轴的 Tensor，能表示含三个分量的数学向量。

| 表达式 | 形状 | 含义 |
| --- | --- | --- |
| `v` | `[3]` | 一维 Tensor，本身不区分行列 |
| `v[:, None]` | `[3, 1]` | 新增最后一条轴，列形状 |
| `v[None, :]` | `[1, 3]` | 新增第一条轴，行形状 |

`None` 增加长度为 1 的轴，不增加元素。二维数组的行列只是展示约定；理解高维 Tensor 时，重点看 shape 与索引顺序。

## 5. RoPE 处理什么、返回什么

RoPE 按 token 的位置旋转 q、k。在多头 attention 中，对每个 head 内的相邻分量配对，使用的维度是 `d_k`（head 维度），不是整个 `d_model`。

```text
hidden vector
  ├─ Q 投影 → 按 head 整理 → RoPE → q′
  ├─ K 投影 → 按 head 整理 → RoPE → k′
  └─ V 投影 → 按 head 整理 → v（本作业不对 v 使用 RoPE）
```

RoPE 函数中的 `x` 是通用输入名，实际传入 q 或 k。返回的是旋转后的向量，形状不变；不返回角度、不返回位置差，也不计算 q 与 k 的点积。

## 6. 从频率到角度表

第 k 对分量为 `(x[2k], x[2k+1])`，使用从 0 开始的编号：

\[
\omega_k=\theta^{-2k/d_k},\qquad k=0,\ldots,d_k/2-1.
\]

`theta` 是基数，`-2k/d_k` 是幂运算的指数，不是数组索引。负指数表示倒数。例如 `10000**(-0.5) = 1/sqrt(10000) = 0.01`。

```python
pair_indices = torch.arange(d_k // 2, dtype=torch.float32, device=device)
frequencies = theta ** (-2 * pair_indices / d_k)
```

当前实现的 `1 / theta**(pair_indices / (d_k // 2))` 在偶数 `d_k` 下与此数学等价。`d_k=8`、`theta=10000` 时，频率为 `[1, 0.1, 0.01, 0.001]`，表示每前进一个位置，各对增加多少弧度。

位置 p 的旋转角度是 `p * frequencies`：

```python
positions = torch.arange(max_seq_len, dtype=torch.float32, device=device)
angles = positions[:, None] * frequencies[None, :]
```

形状为 `[L, 1] * [1, d_k/2] → [L, d_k/2]`。这是通过广播计算两组元素的所有配对乘积，即外积，不是原始一维数组按同一下标相乘。

当 `L=3`、`d_k=8` 时：

```text
[[0, 0,   0,    0    ],
 [1, 0.1, 0.01, 0.001],
 [2, 0.2, 0.02, 0.002]]
```

每行是一个位置，每列是一个分量对，每格已存好角度（弧度）。sin、cos 缓存是对这张表逐元素计算的结果，形状相同。

## 7. token_positions 与查表

`token_positions` 保存输入中每个 token 的位置编号，不是词表 ID，也不一定等于它在当前输入 Tensor 中的下标。

```python
token_positions = torch.tensor([5])
cos = self.cos_cache[token_positions]
```

例如生成时已经有五个 token，新 token 在本次输入中是第 0 个，但在完整序列中位置为 5，因此取缓存第 5 行。缓存必须覆盖该位置。

整数 Tensor 可以统一表达一个、多个或批量位置，一次完成查表：

| 索引 | 缓存形状 | 结果形状 |
| --- | --- | --- |
| `cache[5]` | `[L, F]` | `[F]` |
| `cache[torch.tensor([5])]` | `[L, F]` | `[1, F]` |
| 位置 Tensor `[B, T]` | `[L, F]` | `[B, T, F]` |

位置是整数数据，不是可学习参数。

## 8. 拆分、旋转、交错还原

对每对分量 `(a,b)`，查出的角度系数对应：

\[
R(\alpha)=\begin{bmatrix}\cos\alpha&-\sin\alpha\\\sin\alpha&\cos\alpha\end{bmatrix},
\quad a'=a\cos\alpha-b\sin\alpha,
\quad b'=a\sin\alpha+b\cos\alpha.
\]

代码无需显式构造矩阵 R：

```python
cos = self.cos_cache[token_positions]
sin = self.sin_cache[token_positions]
a = x[..., 0::2]
b = x[..., 1::2]
a_rotated = a * cos - b * sin
b_rotated = a * sin + b * cos
rotated = torch.stack((a_rotated, b_rotated), dim=-1)
return rearrange(rotated, "... pairs two -> ... (pairs two)").to(x.dtype)
```

### 切片是什么意思

`0::2` 从下标 0 起每隔两个取一个；`1::2` 从下标 1 起每隔两个取一个。`...` 保留前面各轴。

```text
x = [10, 20, 30, 40, 50, 60]
a = [10, 30, 50]
b = [20, 40, 60]
```

`a[k]`、`b[k]` 是原来的同一对分量。应称每对的第一、第二个分量，不是 Tensor 的行分量、列分量。

### stack 的“沿最后一维”是什么意思

`stack` 新建一条轴来区分元素来自哪个 Tensor。`dim=-1` 把这个来源索引放最后：

```text
result[i, 0] = a_rotated[i]
result[i, 1] = b_rotated[i]
```

例如 `a_rotated=[10,30,50]`、`b_rotated=[20,40,60]`：

```text
stack(dim=-1) → [[10,20], [30,40], [50,60]]，形状 [3,2]
stack(dim=0)  → [[10,30,50], [20,40,60]]，形状 [2,3]
```

“最后”指索引和 shape 中的位置，不是一个固定的屏幕空间方向。二维例子中最后一条轴恰好展示为列。

### rearrange 为什么要合并

旋转时临时分组，结束后要恢复一个完整的 `d_k` 维向量：

```text
[..., pairs, two] → [..., pairs * two]
[[10,20], [30,40], [50,60]] → [10,20,30,40,50,60]
```

`two` 是自定义轴名，此处因 stack 两个 Tensor 而长度为 2。括号 `(pairs two)` 合并轴，效果等价于 `flatten(-2)`。元素数量与数值不变，没有广播，也没有增加新分量。`.to(x.dtype)` 只恢复输入数据类型。

整个形状流：`[B,T,D] → 两个 [B,T,D/2] → [B,T,D/2,2] → [B,T,D]`。

## 9. 为什么绝对位置旋转能体现相对位置

对某一对分量，设位置为 i、j：

\[
q_i'=R(i\omega)q_i,\qquad k_j'=R(j\omega)k_j.
\]

后续 attention 做点积：

\[
(q_i')^\top k_j'
=q_i^\top R(i\omega)^\top R(j\omega)k_j
=q_i^\top R((j-i)\omega)k_j.
\]

**代码没有显式相减位置或角度；旋转矩阵的组合自然产生相对旋转。** 高频维度对与低频维度对分别按自己的频率产生这种效果。

角度表同一列两行相减，也确实得到 `(j-i)ω`，但它是角度差（弧度），不是位置差本身。实际 RoPE 不需要建立位置对的差值表。

固定内容向量，位置 `(2,5)` 与 `(7,10)` 都相差 3，会有相同的相对旋转。实际 attention 分数仍依赖内容；不能据此说分数只由距离决定。单个频率还有旋转周期性，多种频率共同表达位置；不能保证单个旋转角度唯一识别距离。

## 10. 下一阶段的实现边界与复习重点

当前 RoPE 依赖查出系数与输入分量可广播。未来输入若为 `[B, heads, T, D]`，位置为 `[B,T]`，系数 `[B,T,D/2]` 需要显式补 head 轴为 `[B,1,T,D/2]`。现有代码没有自动处理这种组合，应在接入多头 attention 时核对。

必须掌握：

- `Linear(in,out)` 与权重 `[out,in]` 的区别；W1、W3、W2 的角色。
- 配置整数、输入 Tensor、Parameter、buffer、子模块的区别。
- 增加轴、广播、stack 新建轴、rearrange 合并轴各自做什么。
- RoPE 的输入输出都是向量；查的是各位置的旋转系数，点积在 attention 中。
- 绝对位置用于旋转，相对位置通过后续点积体现。

理解原理即可：缓存的空间与计算取舍、`8D/3` 的参数量来源。当前可以暂缓：GPU kernel 优化、长上下文频率扩展、复杂精度策略。

复习时可以对着代码自述：给定 `x:[2,3,8]`、位置 `[2,3]`，从角度缓存到最终输出，每个中间 Tensor 是什么形状？再解释为什么最终输出仍是向量，而不是 token 对的分数。

## Recap

SwiGLU 用双分支乘法形成非线性特征变换；RoPE 根据位置查出旋转系数，对 q、k 的相邻分量旋转并恢复原形状。今天的关键桥梁是把公式落实为模块状态管理、Tensor 索引与形状操作，并理解相对位置在后续点积中自然体现。
