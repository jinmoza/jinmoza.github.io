---
title: LLVM 236362：AMDGPU F8、F6、F4 Matrix Intrinsic 过宽操作数修复方案
published: 2026-11-01
description: 修复 LLVM AMDGPU 后端在 -O0 下为 F8/F6/F4 WMMA、MFMA 生成过宽寄存器 tuple，导致文本汇编无法重新汇编的问题。
tags:
  - LLVM
  - AMDGPU
  - 编译器
  - CodeGen
lang: zh
abbrlink: llvm-amdgpu-f8f6f4-overwide-operands
---

## 项目摘要

这项工作修复了 LLVM AMDGPU 后端在 `-O0` 下处理 F8/F6/F4 WMMA/MFMA intrinsic 时的一类正确性问题：Clang 和合法 LLVM IR 可以使用“最大宽度”的向量类型承载矩阵输入，而运行时 format 实际只消费其中一个低位前缀。修复前，SelectionDAG 和 GlobalISel 都会把向量类型的完整宽度带入机器操作数，导致 `llc` 输出的寄存器 tuple 与 format 冲突，生成的文本汇编无法被 `llvm-mc` 重新汇编。

最终方案在两套指令选择器分流之前，于 `AMDGPULowerIntrinsics` 中增加共享的 pre-isel 规范化：分别读取矩阵 A、B 的 format，复用 AMDGPU 现有的 format-to-register-count 映射，只保留硬件真正读取的低位元素，并以精确的 source overload 重建同一个 intrinsic。这样既保持了现有 IR 的兼容性，也让寄存器分配、依赖分析、汇编打印和机器编码看到一致的操作数范围。

- 上游 Issue：[llvm/llvm-project#236362](https://github.com/llvm/llvm-project/issues/236362)
- 上游 PR：[llvm/llvm-project#237722](https://github.com/llvm/llvm-project/pull/237722)
- 生产代码与完整补丁：[PR #237722 Files](https://github.com/llvm/llvm-project/pull/237722/files)

## 1. 问题为什么真实存在

### 1.1 一个 immediate format 同时决定数据格式和寄存器宽度

gfx1250 WMMA 与 gfx950 MFMA 的低精度矩阵指令使用 format 参数描述 A、B 的元素格式。不同格式对应不同的硬件 source tuple 宽度：

| 元素格式 | format 值 | WMMA 每个 source | MFMA 每个 source |
| --- | ---: | ---: | ---: |
| FP8 / BF8 | 0 / 1 | 16 × i32 | 8 × i32 |
| FP6 / BF6 | 2 / 3 | 12 × i32 | 6 × i32 |
| FP4 | 4 | 8 × i32 | 4 × i32 |

WMMA 和 MFMA 对 0..4 的枚举命名不同：WMMA 使用 `MATRIX_FMT_*`，MFMA 使用 `FP8_E4M3`、`FP8_E5M2`、`FP6_E2M3`、`FP6_E3M2`、`FP4_E2M1`。这里的数字只是两组相同顺序的 format 枚举，不代表向量长度或 scale 值。

宽度映射已经存在于 `AMDGPUBaseInfo`：

- `wmmaScaleF8F6F4FormatToNumRegs()` 返回 16、12 或 8；
- `mfmaScaleF8F6F4FormatToNumRegs()` 返回 8、6 或 4。

因此本次修复不应该再维护一份 format switch，而应复用后端已有的唯一映射。

### 1.2 Clang `-O0` 会走到这条路径

这不是只靠手写 IR 才能触发的边界情况。当前 Clang builtin 的公开签名使用最大 source overload：

- 三类 WMMA builtin 的 A、B 都是 `<16 x i32>`；
- 两类 MFMA builtin 的 A、B 都是 `<8 x i32>`。

当用户选择 FP6、BF6 或 FP4 时，向量容器会比 format 真正需要的宽。显式检查 `clang -O0 -emit-llvm` 和禁用后续 LLVM passes 的原始前端 IR，都能观察到这种最大 overload。

在优化流水线中，AMDGPU InstCombine 已经会插入低位 `shufflevector`，提前把 source 收缩成精确 overload，所以 `-O1` 及以上可能掩盖问题。这里必须区分两个概念：是 Clang/`opt` 的 IR 优化流水线做了规范化，而不是单独把 `llc` 的 CodeGen 优化级别设为 `-O2` 就必然会运行 InstCombine。

### 1.3 Verifier 有意接受“至少足够宽”

AMDGPU verifier 的契约是：

```text
actual source width >= width required by format
```

例如，FP4 WMMA 只需要 `<8 x i32>`，但 `<16 x i32>` 仍是合法 IR。这个契约使已有的最大 overload producer 保持兼容，也给优化阶段留下规范化空间。因此不能把过宽输入简单归类为非法 IR，更不能只通过收紧 verifier 来“修复” CodeGen。

### 1.4 指令选择、汇编打印和机器编码看到了不同的真相

修复前的关键路径是：

```text
Clang -O0 / 合法未优化 IR
       │
       │  <16 x i32> + FP4（WMMA）
       ▼
AMDGPU verifier：合法，因为 16 >= 8
       │
       ▼
SelectionDAG / GlobalISel
按 overloaded vector type 保留 16-register source
       │
       ▼
llc 打印 v[0:15]，同时标注 MATRIX_FMT_FP4
       │
       ▼
llvm-mc：FP4 只能使用 8-register tuple，拒绝汇编
```

代表性的错误汇编是：

```asm
v_wmma_f32_16x16x128_f8f6f4 \
  v[32:39], v[0:15], v[16:31], v[32:39] \
  matrix_a_fmt:MATRIX_FMT_FP4 matrix_b_fmt:MATRIX_FMT_FP4
```

`llvm-mc` 报告：

```text
error: wrong register tuple size for MATRIX_FMT_FP4
```

MFMA 的表现相同：FP4 指令被打印为 8-register A/B tuple，但 assembler 只允许 4-register tuple。

这个问题有一个容易误导调查的现象：直接执行 `llc -filetype=obj` 可以成功。原因是机器编码记录 source 的起始寄存器和 format，反汇编器再根据 format 恢复正确的结束寄存器；文本汇编则把 tuple 的起止位置都显式写出来，所以能暴露二者矛盾。直接 object 成功并不说明内部状态正确，因为寄存器分配、hazard recognizer 和 waitcnt 分析仍然把未被硬件读取的高位寄存器当成真实依赖。

## 2. 为什么问题必须同时覆盖两套指令选择器

AMDGPU 当前同时存在 SelectionDAG 和 GlobalISel：

```text
LLVM IR
   │
   ├── SelectionDAG：成熟的旧路径
   │
   └── GlobalISel：基于通用 MIR 的新路径
```

使用同一个最小输入分别运行：

```bash
llc -O0 -global-isel=0 ...
llc -O0 -global-isel=1 -global-isel-abort=1 ...
```

两条路径都会生成过宽 tuple。`-global-isel-abort=1` 很重要，它禁止 GlobalISel 失败后回退到 SelectionDAG；若使用允许 fallback 的模式，即使测试通过，也不能证明 GlobalISel 自身正确。

因此，分别在两个 selector 中修同一问题会产生重复逻辑和长期漂移风险。更合理的边界是在二者分流前建立同一份 canonical IR。

## 3. 范围分析：为什么是五类 intrinsic

对 TableGen、verifier、InstCombine、SelectionDAG/GlobalISel 引用以及 Clang builtin 做完整枚举后，具有独立 A/B runtime format、并存在同一过宽契约的 intrinsic 恰好有五类：

1. `amdgcn_wmma_f32_16x16x128_f8f6f4`
2. `amdgcn_wmma_scale_f32_16x16x128_f8f6f4`
3. `amdgcn_wmma_scale16_f32_16x16x128_f8f6f4`
4. `amdgcn_mfma_scale_f32_16x16x128_f8f6f4`
5. `amdgcn_mfma_scale_f32_32x32x64_f8f6f4`

五类都在未修复基准上用 SelectionDAG 和禁止 fallback 的 GlobalISel 直接复现过，不是从第一个 WMMA case 推测出来的预防性覆盖。

这里的 `scaled` 表示矩阵运算还携带 A/B 的 scale 信息，不是“缩小向量”。WMMA `scale` 与 `scale16` 的主要区别是 scale source 类型分别包含 i32 与 i64 形式；它们的 matrix format 和 source tuple 规则相同。MFMA 在这组 runtime-format intrinsic 中只有 scaled 形式。

### strict gfx1250 的特殊顺序

在 strict gfx1250 上，普通 unscaled WMMA 会在同一个 pre-isel pass 中转换成 scale exponent 为 0 的 scaled WMMA，相当于中性缩放。但普通 WMMA 仍是独立的 IR intrinsic 入口，不能因为最终变成 scaled 形式就省略覆盖。

正确顺序必须是：

```text
unscaled WMMA
     │
     ▼
先按 format 规范化 source overload
     │
     ▼
再执行既有 unscaled -> neutral-scaled 转换
```

如果先删除旧调用、再尝试窄化，或者 normalization 之后仍把旧指针交给既有 visitor，就会产生 use-after-erase 风险；如果完全跳过普通入口，过宽 overload 又会被原样带进 scaled WMMA。

## 4. 方案选型

### 4.1 最终选择：`AMDGPULowerIntrinsics`

`AMDGPULowerIntrinsics` 的文件级职责就是处理“否则必须在 SelectionDAG 和 GlobalISel 中分别实现”的 AMDGPU intrinsic lowering。它具备四个关键条件：

1. **`-O0` 也运行。** 它是 CodeGen 正确性路径，不依赖 IR 优化级别。
2. **位于两套 selector 之前。** 一次规范化同时覆盖 SelectionDAG 和 GlobalISel。
3. **位于寄存器分配之前。** 后续 RA、hazard 和 waitcnt 从一开始就看到硬件真实读取的范围。
4. **现有基础设施已经完整。** TableGen 已有不同宽度和 mixed-format 的指令变体，BaseInfo 已有 format-to-width 映射；只需把 intrinsic 类型整理正确。

整体位置如下：

```text
合法但未规范化的 LLVM IR
            │
            ▼
AMDGPULowerIntrinsics      ← 本次修改
            │
            ├── SelectionDAG
            └── GlobalISel
                    │
                    ▼
             MachineInstr / RA
                    │
                    ▼
              AsmPrinter / MC
```

### 4.2 被否决的备选方案

#### 在 `-O0` 启用 InstCombine

现有 AMDGPU InstCombine 的确已有同构窄化，但它只是完整 InstCombine 中的一条 target hook。为一个后端正确性问题在所有 O0 编译中启用完整 InstCombine，会同时触发大量常量折叠、代数化简、cast 合并、比较重写和 DCE，改变 O0 的调试与编译行为，范围明显过大。

#### 只修改 Clang

Clang 不是 LLVM IR 的唯一 producer。Verifier 已经承诺过宽 IR 合法，外部前端、旧 bitcode 和手写 IR 都可以进入后端，所以后端不能把正确性依赖于某个前端提前窄化。

#### 分别修改 SelectionDAG 和 GlobalISel

这会复制 format 映射、参数索引和重建规则，既增加实现量，也容易让两套 selector 的覆盖发生漂移。

#### 在 AsmPrinter 或 MC 层截断 tuple

它可以让文本汇编表面上通过，但修复发生在 RA、hazard 和 waitcnt 之后，无法纠正内部过宽依赖，也会把一个 CodeGen 建模错误伪装成打印问题。

#### 收紧 verifier 或 intrinsic 签名

这会拒绝当前 Clang O0 正常生成、且现有契约明确允许的 IR，构成兼容性变化；要这样做还必须同步修改 Clang 和其他 producer，不适合作为当前 bug 的最小修复。

## 5. 最终算法

### 5.1 统一 helper，显式分发

实现增加一个本地 helper：

```text
narrowF8F6F4MatrixOperands(IntrinsicInst &)
    -> { Current IntrinsicInst*, Changed }
```

`run()` 显式列出五个 intrinsic ID，而不是按名字模糊匹配。显式 switch 让当前范围可审计；未来如果新增第六类 runtime-format intrinsic，必须同时补充分发和测试，而不会被未经验证的“通用规则”静默纳入。

两类签名的参数布局不同：

| family | source A/B | format A/B | overload 类型列表 |
| --- | --- | --- | --- |
| WMMA | 参数 1 / 3 | 参数 0 / 2 | 返回类型、A 类型、B 类型 |
| MFMA | 参数 0 / 1 | 参数 3 / 4 | A 类型、B 类型 |

因此方案共享的是上层算法，而不是假设 WMMA/MFMA 有相同签名。helper 内先通过 family switch 取得索引和 overload 规则，再执行统一逻辑。

### 5.2 A、B 必须独立计算

对每个 source 分别执行：

```text
读取自己的 format
    │
    ▼
调用对应 family 的 format-to-width helper
    │
    ▼
Actual == Required：保留原 Value
Actual >  Required：保留 [0, Required) 低位前缀
```

不能用 A 的 format 同时决定 B，也不能要求“两侧都过宽”才触发。真实 Clang O0 形状经常正是 mixed-format 加单侧过宽，例如：

- WMMA：A=BF8，`<16 x i32>` 已精确；B=FP6，`<16 x i32>` 需要窄到 12；
- MFMA：A=BF6，`<8 x i32>` 需要窄到 6；B=BF8，`<8 x i32>` 已精确。

这两个 case 同时验证 A/B format 独立、两种单侧方向以及 FP6/BF6 的中间宽度，而不需要把所有组合机械展开成测试矩阵。

### 5.3 先完整验证，再修改

合法输入应满足：

- format 是 `ConstantInt`，并位于对应 family 的 0..4 枚举范围；
- source 是 i32 `FixedVectorType`；
- WMMA overload 宽度属于 8/12/16，MFMA 属于 4/6/8；
- 两侧实际宽度都不小于各自 format 的需求。

helper 在产生任何新 IR 前先验证两侧。如果任一侧是 malformed IR，则整个 helper no-op，把诊断和拒绝继续交给现有 verifier/selector；它不会只修另一侧、补零、猜测 format，或把非法输入静默洗成合法 IR。这个 release-build 防御也避免把越界 MFMA format 错当成 FP8。

### 5.4 使用 identity-prefix `shufflevector`

过宽 source 通过 mask `[0, 1, ..., Required-1]` 生成低位前缀：

```llvm
%narrow = shufflevector <16 x i32> %src, poison,
                        <8 x i32> <0, 1, 2, 3, 4, 5, 6, 7>
```

方案早期曾考虑使用 `llvm.vector.extract` 表示连续低位提取。针对候选实现的正向测试发现，AMDGPU GlobalISel 会在该表示上因无法合法化而 abort，而等价的 identity-prefix `shufflevector` 可以由 SelectionDAG 和 GlobalISel 都稳定处理。因此最终实现选择 `shufflevector`。这个修正体现了一个重要原则：IR 语义等价不等于目标 legalization 能力等价，最终表示必须以两条真实 selector pipeline 验证。

测试不仅检查“结果宽了还是窄了”，还绑定 mask 的非零后续元素，确保实现取得的是低位 `[0, N)`，而不是任意 N 个元素或高位切片。

### 5.5 重建 overloaded intrinsic

LLVM intrinsic declaration 的函数类型已经编码 source overload，因此不能对旧调用直接 `setArgOperand` 塞入不同向量类型。只要任一 source 发生变化，就必须：

1. 复制完整实参数组，只替换需要窄化的 source；
2. 按 WMMA/MFMA 各自的 overload 列表创建同 ID 新调用；
3. 保留 debug location、metadata、attributes、fast-math flags、operand bundles、tail-call kind、calling convention 和 SSA 名称；
4. `replaceAllUsesWith(NewI)` 后删除旧调用；
5. 返回新的 `Current` 指针，供普通 WMMA 的 strict lowering 继续使用。

若 A/B 都已是精确宽度，helper 直接返回原调用和 `Changed=false`，不创建冗余 shuffle 或 declaration。这也保证新 overload 即使稍后再次被 module 遍历，也会幂等 no-op。

## 6. 为什么截掉高位元素保持语义

以 FP4 WMMA 为例：

```text
原容器：a[0] ... a[7] | a[8] ... a[15]
硬件读取：a[0] ... a[7]
修复保留：a[0] ... a[7]
```

等价性有三层独立依据：

1. `AMDGPUBaseInfo` 和 MC 校验共同定义了每个 format 的真实寄存器宽度；
2. 现有 AMDGPU InstCombine 已经对同五类 intrinsic 做相同的低位前缀提取；
3. 修复前直接生成 object 后的反汇编本来就按 format 显示窄 tuple，说明高位没有进入最终机器编码。

因此本次变换没有定义新的数学语义，只是把“format 已经隐含决定的有效前缀”显式反映到 overloaded source 类型中。

保持不变的内容包括：intrinsic ID、format、累加器、scale/reuse 等其他参数、结果类型、数值计算和内存行为。允许变化的是内部 IR 形状、寄存器编号、spill/依赖指令以及最终 object 字节布局；因为 RA 现在看到了更准确的 live range，所以不要求修复前后 object 完全相同。

## 7. 边界问题与范围控制

### 7.1 mixed-format

A、B 可以选择不同格式，例如 WMMA A=FP4、B=FP8。两侧需要的 tuple 分别是 8 和 16，不能共享一个宽度。mixed-format 测试的价值不是新增格式组合，而是证明实现真正独立读取了两个 format。

### 7.2 仅一侧过宽

另一侧已经精确时，不应为了“统一”再创建无意义的 shuffle。新 intrinsic 的 overload 必须组合“窄化后的一侧类型”和“原有精确类型”。

### 7.3 FP6/BF6 中间档

只测试 FP4 会留下一个漏洞：错误实现可能把所有非 FP8 输入都统一缩到最小宽度。WMMA 12-register 与 MFMA 6-register case 证明代码复用了完整 format 映射，而不是只实现了“最大到最小”。

### 7.4 固定 FP4 的三个相邻 intrinsic

另外三个 `32x16x128.f4` WMMA intrinsic 的 format 固定为 FP4，没有 runtime A/B format。手写非规范 overload 可以通过当前 verifier，但会在 SelectionDAG/GlobalISel 直接 `Cannot select`，而不是先生成汇编再被 `llvm-mc` 拒绝。

它们没有被并入本次 helper，原因是：

- 当前 Clang O0 builtin 已生成精确的 A `<16 x i32>`、B `<8 x i32>`，正常生产路径不可达该过宽形状；
- 没有 runtime format 可作为“应该保留多少元素”的动态语义依据；
- 更合理的修复方向可能是 verifier 精确约束和更早诊断，需要单独枚举异常形状与兼容性影响。

这不是忽略已知问题，而是区分“当前生产路径的 CodeGen 正确性 bug”和“手写 IR 的 verifier 契约缺口”，避免把不同根因打包进同一个上游 patch。

### 7.5 MFMA verifier 的诊断参数问题

调查还发现，MFMA Src1 宽度判定正确读取参数 4 的 B format，但失败诊断把参数 5 的 A scale selector 当作上下文打印。它只影响错误信息，不改变接受条件或本次 lowering，因此被记录为独立的小修复，没有顺手混入 #236362。

## 8. 测试策略：证明修复的是完整契约

### 8.1 RED 基线

修复前，五类 intrinsic 都在以下两条 pipeline 中生成过宽 tuple，并被 `llvm-mc` 拒绝：

```text
llc -O0 -global-isel=0 | llvm-mc
llc -O0 -global-isel=1 -global-isel-abort=1 | llvm-mc
```

额外基线覆盖 mixed-format、A/B 两种单侧过宽方向以及 FP6/BF6 中间宽度，避免只修 issue 最初展示的对称 FP4 WMMA。

### 8.2 两份聚焦回归测试

- WMMA overwide：`llvm/test/CodeGen/AMDGPU/llvm.amdgcn.wmma.f8f6f4.overwide.ll`
- MFMA overwide：`llvm/test/CodeGen/AMDGPU/llvm.amdgcn.mfma.scale.f8f6f4.overwide.ll`

测试同时锁定：

- 3 个 WMMA 与 2 个 MFMA intrinsic 的显式分发；
- SelectionDAG 与禁止 fallback 的 GlobalISel；
- FP4 最窄宽度和 FP6/BF6 中间宽度；
- mixed-format 与仅一侧窄化；
- 低位 prefix 的具体来源和新 intrinsic 的精确 overload；
- gfx1250 non-strict 与 strict 模式；
- strict 模式下 unscaled WMMA 转为 scaled WMMA，且两侧 neutral scale exponent 均为 0；
- `.ll -> llc -> .s -> llvm-mc -> .o` 的真实文本汇编闭环。

FileCheck 用于观察 opcode、format、IR mask 和 overload；真正强制 tuple 宽度的是 `llvm-mc`。仅检查 `llc` 退出码或使用宽松正则匹配 opcode，都无法证明输出汇编能够重新组装。

### 8.3 既有生成测试与全量回归

规范化改变了合法过宽输入的 tuple、寄存器分配、load/wait 调度和部分 scratch register 选择，因此四份既有自动生成 CodeGen 测试需要按原脚本重新生成并人工审查，而不能只新增专项测试后忽略旧 CHECK 失败。

最终验证结果：

- 8 个相关 verifier、InstCombine 与 CodeGen 测试全部通过；
- WMMA FP4、FP6、精确 FP8，以及 MFMA FP4 的真实 object/disassembly round-trip 通过；
- `check-llvm-codegen-amdgpu` 共发现 5243 项：5236 通过、2 unsupported、5 expected failure、0 unexpected failure；
- `git diff --check` 与 `git clang-format` 通过；
- PR 仅包含一个 production 源文件、四个更新后的生成测试和两个新增聚焦测试。

## 9. 结果与工程价值

修复后的 WMMA FP4 汇编变为：

```asm
v_wmma_f32_16x16x128_f8f6f4 \
  v[8:15], v[0:7], v[16:23], v[8:15] \
  matrix_a_fmt:MATRIX_FMT_FP4 matrix_b_fmt:MATRIX_FMT_FP4
```

MFMA FP4 source tuple 则从 `v[0:7]` / `v[8:15]` 收缩为 `v[0:3]` / `v[8:11]`。`llc` 的文本输出现在与 MC 校验和硬件编码一致。

在一个 WMMA 最小例中，静态机器码观察到声明的 VGPR 数从 40 降到 24，`scratch_load_b32` 从 9 条降到 8 条；MFMA 代表例的总 VGPR 数不变，但 source tuple 已被修正。这些结果说明更准确的依赖模型可能减少寄存器压力和保守操作，但没有真机 benchmark、profiling 或 PMU 数据，因此本项目只主张正确性修复和静态资源改善，不声称运行性能提升。
