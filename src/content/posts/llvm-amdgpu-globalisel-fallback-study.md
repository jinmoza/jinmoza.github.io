---
title: 从宽操作数修复到 AMDGPU GlobalISel fallback：双指令选择流水线研究与实测
published: 2026-11-08
description: 从 LLVM AMDGPU 宽操作数修复出发，梳理 SelectionDAG 与 GlobalISel 的关系，并统计 11322 个 AMDGPU case 中的 GlobalISel fallback。
tags:
  - LLVM
  - AMDGPU
  - GlobalISel
  - CodeGen
lang: zh
abbrlink: llvm-amdgpu-globalisel-fallback-study
---

## 研究背景

这项工作起源于 [LLVM #236362](https://github.com/llvm/llvm-project/issues/236362)，一个 AMDGPU CodeGen 正确性问题。F8、F6 和 F4 matrix intrinsic 使用了过宽的 vector source，进入后端后又形成过宽的 register tuple。分析这个 issue 时，我们发现 LLVM AMDGPU 后端同时存在 SelectionDAG 和 GlobalISel 两条指令选择路线。同一个后端为什么保留两条路线，它们是什么关系、又有什么区别？带着这些疑问，我们开始寻找和阅读 GlobalISel 的相关文档。

为了回答这些最初的问题，我们先后阅读了 [GlobalISel 官方文档](https://llvm.org/docs/GlobalISel/index.html)、[2015 年原始提案](https://lists.llvm.org/pipermail/llvm-dev/2015-November/092566.html)、[EuroLLVM 2023 教程](https://llvm.org/devmtg/2023-05/slides/Tutorial-May11/01-Bradbury-GlobalISelTutorial.pdf)和 [Apple AArch64 默认启用 RFC](https://discourse.llvm.org/t/enabling-globalisel-for-apple-aarch64-platforms/63953)。随着对两条流水线的历史、结构和部署情况有了更具体的认识，研究也从“为什么存在两条路线、它们有什么区别”进一步展开：GlobalISel 的函数级表示究竟带来了多少实际收益；Legalizer、RegBankSelect 和 InstructionSelect 的边界是否合理；两套 selector 的长期并存会留下多少覆盖和维护缺口；允许静默 fallback 时，又该如何知道最终代码究竟由哪条路径生成。

[2025 年 LLVM Developers' Meeting 的 GlobalISel CI/CD 演讲](https://llvm.org/devmtg/2025-10/slides/lightning_talks/hickey.pdf)展示过一套持续收集 GlobalISel fallback 的原型。这证明问题可以测量，但公开材料没有给出完整的函数分母、原始事件、稳定的归一化规则和可重放的小例子。于是我们为 AMDGPU 搭建了一套固定版本、使用公开语料、无需真实 GPU 的测试流程，并把结果分别保存在 case、函数事件、归一化签名和 reduced artifact 四个层次。

本文因此同时记录两部分内容：前半部分整理这项实验所依赖的指令选择概念和社区背景，后半部分说明测试台的统计口径、实测结果及其边界。全文围绕三个问题展开：

1. **为什么会研究这两条指令选择流水线？**
2. **阅读和讨论后，我们对 LLVM 后端形成了什么认识，又留下了哪些问题？**
3. **为什么 fallback 统计是合理的下一步，实测究竟回答了什么、没有回答什么？**

## 1. 从一次 AMDGPU 正确性修复开始

### 1.1 最初遇到的不是 GlobalISel 问题，而是 CodeGen 正确性问题

上游 LLVM #236362 涉及 AMDGPU F8/F6/F4 WMMA/MFMA matrix intrinsic。我们讨论中口头所说的“宽数组缩窄”，准确实现对象是**过宽的 i32 vector source 及其形成的 register tuple**。Clang `-O0` 可以生成使用最大宽度向量容器的合法 intrinsic，例如用 `<16 x i32>` 承载 FP4、FP6 或 FP8 source；真正需要多少 VGPR 则由 runtime matrix format 决定。

问题在于：后端没有在指令选择前把 source 类型收窄到 format 对应的有效前缀。于是 FP4/FP6 指令仍携带最大宽度的 register tuple：

```text
intrinsic 容器：允许“至少足够宽”
matrix format：决定硬件真正读取的寄存器数
llc 内部 MachineInstr：仍按过宽 source 建模
文本汇编：显式打印过宽 tuple
llvm-mc：发现 tuple 宽度与 format 冲突并拒绝汇编
```

直接生成 object 有时仍能成功，是因为机器编码保存的是起始寄存器和 format，tuple 结束位置可由 format 推导；错误的结束位置无法真正编码进去。经过文本汇编时，起止范围会被完整打印，矛盾才暴露。这个现象不能证明内部表示正确：寄存器分配、hazard 和 waitcnt 等分析仍可能把未被硬件读取的高位寄存器视为真实依赖。

详细问题、修复和验证分别保存在：

- 上游问题：[llvm/llvm-project#236362](https://github.com/llvm/llvm-project/issues/236362)
- 公开修复报告：[LLVM 236362：AMDGPU F8、F6、F4 Matrix Intrinsic 过宽操作数修复方案](https://jinmoza.github.io/posts/llvm-amdgpu-f8f6f4-overwide-operands/)

### 1.2 分析 issue 时发现了两条指令选择路线

同一个最小输入分别走下面两条路径时都会产生过宽 tuple：

```bash
# SelectionDAGISel
llc -O0 -global-isel=0 ...

# GlobalISel，并禁止失败后偷偷回退
llc -O0 -global-isel=1 -global-isel-abort=1 ...
```

为了复现和验证 #236362，我们需要让同一个最小输入分别经过 SelectionDAG 和 GlobalISel。也正是在查看命令、测试和 AMDGPU CodeGen 流程时，我们注意到：LLVM 在同一个目标后端中保留了两套指令选择实现。这一发现本身就带来了研究兴趣——为什么已经有 SelectionDAG，还要设计 GlobalISel？两者只是新旧替代关系，还是在表示能力、流水线划分和工程取舍上存在不同？

### 1.3 两条路线共有的问题放在共同的前置 Pass 中处理

在 #236362 中，两条路径接收到同一个过宽 intrinsic，并产生同样的错误。这说明修复不应分别复制到 SelectionDAG 和 GlobalISel 的 selector 中，而应放在两条路径分流前共同经过的位置。

现有 `AMDGPULowerIntrinsics` Pass 的源码开头已经说明了这项职责：它专门降低那些否则需要在 SelectionDAG 和 GlobalISel 中分别处理的 intrinsic。因此，我们没有为这次修复新建 Pass，而是在现有 `AMDGPULowerIntrinsics` 中加入 `narrowF8F6F4MatrixOperands`。它在两条指令选择路径分流前，分别按照 A、B 的 format 保留低位有效前缀，并用精确的 source overload 重建 intrinsic。

这样，“按 format 缩窄输入”就从可选的 `AMDGPUInstCombine` 优化变成了 `-O0` 也会执行的 CodeGen 正确性步骤，并且两条指令选择路线都能复用同一份处理逻辑。

## 2. 从 LLVM IR 到目标 Machine IR：GlobalISel 所处的位置

### 2.1 指令选择连接目标无关语义与具体 ISA

LLVM IR 描述的是相对目标无关的程序语义，真实处理器提供的却是带有具体类型、寄存器、立即数和编码约束的机器指令。二者不是逐条对应的：一个 LLVM IR 操作可能需要展开为多条机器指令，多个 IR 操作也可能融合成一条目标指令；同一种语义还可能存在多种指令序列，需要在执行速度、代码尺寸和寄存器压力之间选择。

因此，从 LLVM IR 走向汇编时必然要经过指令选择。它解决的核心问题是：怎样把目标无关的操作组合，变成当前 ISA 真正支持并且代价合适的目标指令形式。

### 2.2 LLVM 为这一步保留了三条实现路径

LLVM 中可以承担这项工作的路径包括 FastISel、SelectionDAGISel 和 GlobalISel。它们的共同交付物是目标相关 Machine IR：

```text
                         ┌─ FastISel ────────────────┐
LLVM IR ────────────────┼─ SelectionDAGISel ───────┼→ 目标 Machine IR
                         └─ GlobalISel ───────────────┘
```

`FastISel` 面向较低的编译开销，覆盖和优化能力有限，无法处理时通常交给 SelectionDAGISel。传统的 `SelectionDAGISel` 会按基本块构造一套专用 DAG，在其中完成类型与操作合法化、DAG Combine、模式匹配和调度，再生成 MachineInstr。这里需要区分两个名称：`SelectionDAG` 是这条路径使用的中间表示，`SelectionDAGISel` 才是围绕它建立的完整指令选择流水线。

GlobalISel 则是另一套完整框架，而不是与 SelectionDAG 并列的单个匹配算法。它把翻译、合法化、寄存器库选择和目标指令选择组织在 Machine IR 上，并配有 Combiner、TableGen matcher、目标 hook、失败诊断和 fallback 等基础设施。

### 2.3 GlobalISel 直接把程序带入 Machine IR

GlobalISel 的第一步 `IRTranslator` 会把 LLVM IR 翻译成 gMIR。此时程序已经进入由 `MachineFunction`、`MachineBasicBlock` 和 `MachineInstr` 承载的 Machine IR 世界。gMIR 不是 Machine IR 之前的另一套独立 IR，而是 Machine IR 中仍使用 `G_ADD`、`G_LOAD` 等通用操作、尚未完全加入目标约束的状态。

以 AMDGPU kernel 中的一次 `i32` 加法为例。下面的 MIR 只用于展示约束如何逐步增加，具体 opcode 后缀会随目标芯片和编码形式变化。

```text
LLVM IR
  %r = add i32 %a, %b

IRTranslator 之后
  %r:_(s32) = G_ADD %a, %b
  └─ 已进入 Machine IR；知道这是 s32 加法，但还没有 Register Bank、
     Register Class 和 AMDGPU 具体 opcode

Legalizer 之后
  %r:_(s32) = G_ADD %a, %b
  └─ AMDGPU 支持这种操作和位宽，因此本例不需要拆分或扩展；
     如果组合不合法，Legalizer 会在这里改写它

RegBankSelect 之后（假设该值是 divergent）
  %r:vgpr(s32) = G_ADD %a, %b
  └─ 加法仍是通用 G_ADD，但结果和操作数已被约束到 VGPR bank；
     如果值是 uniform，则可能选择 SGPR bank

InstructionSelect 之后
  %r:vgpr_32 = V_ADD_U32_* %a, %b
  └─ G_ADD 被替换为 AMDGPU 目标指令，虚拟寄存器进一步获得
     VGPR_32 Register Class 约束
```

到这里得到的仍然是使用虚拟寄存器的目标 MIR。把它分配到具体物理 VGPR，是后续 Register Allocation 的工作，不属于 GlobalISel。这个例子也说明，gMIR 与目标 MIR 并不是两套互不相关的数据结构：GlobalISel 始终在 Machine IR 中工作，只是 Legalizer、RegBankSelect 和 InstructionSelect 逐步增加目标约束，并在必要时替换其中的指令。

SelectionDAGISel 也要完成合法化、组合和目标指令选择，但组织方式不同：

```text
SelectionDAGISel
  LLVM IR 基本块
    → 构造临时 SelectionDAG：add:i32 节点
    → Type/Operation Legalize 与 DAG Combine
    → 模式匹配为目标 machine node
    → DAG 调度并发射目标 MachineInstr

GlobalISel
  LLVM IR 函数
    → 在 MachineFunction 中创建 G_ADD
    → 在同一 Machine IR 表示上合法化
    → 分配 Register Bank
    → 替换为目标 MachineInstr
```

因此，两条路径的差别不是“一条逐步加约束，另一条一次完成”。SelectionDAG 同样会逐步合法化和组合；真正的结构差别是，SelectionDAGISel 为每个基本块建立一套临时 DAG，并在完成匹配和调度后才发射 MachineInstr，而 GlobalISel 从一开始就使用函数级 Machine IR，把寄存器库选择等责任显式拆成独立阶段。SelectionDAGISel 没有与 `RegBankSelect` 一一对应的独立 Pass，相关寄存器约束会在目标节点、匹配规则以及最终生成 MachineInstr 的过程中逐步体现。

函数级表示使 GlobalISel 可以保留跨基本块的 use-def 关系，也为跨基本块分析和组合提供了条件，但这不等于它会自动进行全函数最优指令覆盖，更不等于仅凭作用域更大就一定生成更好的代码。

这里的“函数级”也不等于“模块级”。GlobalISel 以完整 `MachineFunction` 为工作对象，但 LLVM 没有一套与 LLVM IR `Module` 对称、普遍承载所有 MachineFunction 和机器全局对象的完整 `MachineModule IR`。当前主要依靠逐函数 `MachineFunctionPass`、保存模块级机器信息的 `MachineModuleInfo`，以及少数特殊 ModulePass 处理跨函数需求。

例如，`foo` 和 `bar` 的目标 MIR 中如果出现相同的指令序列，MachineOutliner 需要同时查看两个 MachineFunction，普通的逐函数 Pass 无法完成这项工作。LLVM 因此使用特殊的 IR `ModulePass`，通过 `MachineModuleInfo` 访问多个 MachineFunction。这条专门通道可以完成跨函数 outline，但不代表机器层始终存在一个可供任意 Pass 自由分析和改写的完整 MachineModule。函数 Pass 可以使用预先准备的跨函数只读信息，机器层却没有从头到尾保持一个全模块 MIR 世界。

### 2.4 同一份 Machine IR 在四个核心阶段中逐步收紧

GlobalISel 的核心流水线可以写成：

```text
LLVM IR
  ↓ IRTranslator
gMIR
  ↓ 可选 Pre-Legalizer Combiner
经过早期优化的 gMIR
  ↓ Legalizer
目标支持其操作和类型的 gMIR
  ↓ 可选 Post-Legalizer Combiner
合法化后的优化 gMIR
  ↓ RegBankSelect
已确定 Register Bank 的 gMIR
  ↓ InstructionSelect
目标相关 Machine IR
```

这四个核心阶段分别建立一种可以检查的状态：

- `IRTranslator` 把 LLVM IR 语义翻译为通用 MachineInstr；
- `Legalizer` 消除目标不支持的“操作 + LLT”组合，必要时拆分、扩展或改写；
- `RegBankSelect` 为虚拟寄存器确定 GPR、FPR、SGPR、VGPR 等 Register Bank，但还没有完成物理寄存器分配；
- `InstructionSelect` 消除剩余的 `G_*` 通用 opcode，选择目标指令，并进一步施加 Register Class 等约束。

其中，“合法”只表示当前通用操作和数据形状已经得到目标支持，并不表示已经选好目标指令。我们在当前 `gfx942` 工具链上实际观察到，IRTranslator 可以生成 `G_ADD s8`；AMDGPU Legalizer 会把两个 `s8` 输入扩展为 `s16`，使用 `G_ADD s16` 完成加法，再把结果截断为 `s8`。Legalizer 之后保留下来的仍是通用 `G_ADD`，后续 RegBankSelect 和 InstructionSelect 才继续添加 Register Bank 约束并选择 AMDGPU opcode。

这张四阶段图描述的是职责骨架，不是完整的 Pass 列表。实际路径还可能插入 Pre/PostLegalizer Combiner、CSE、KnownBits、`Localizer`、常量和目标专用 lowering；核心 Pass 内部也会调用 TableGen 生成的 matcher、手写 C++、公共 helper 和目标 hook。

### 2.5 目标差异在整个 lowering 过程中逐步显现

CPU、GPU 或不同 ISA 的差异并不是到 `InstructionSelect` 才突然出现。target triple、CPU 和 features 在创建 `TargetMachine` 时已经确定，目标知识随后逐层进入编译过程：

```text
LLVM IR：triple、DataLayout、address space、calling convention、target intrinsic
  ↓
IRTranslator / CallLowering：ABI 与调用约定
  ↓
Legalizer：目标支持的操作和位宽
  ↓
RegBankSelect：GPR/FPR 或 AMDGPU SGPR/VGPR 等寄存器体系
  ↓
InstructionSelect：具体 ISA opcode
  ↓
Machine/MC：调度、物理寄存器、指令编码和对象格式
```

两个 CPU ISA 对同一个普通算术操作的差异，可能到 ABI lowering、合法化和指令选择时才明显出现；GPU 的 address space、kernel calling convention、线程模型和目标 intrinsic 则往往已经体现在 LLVM IR 中。目标是从编译开始就确定的，只是越靠近机器码，约束越具体。

### 2.6 指令选择完成后，LLVM 后端仍要继续工作

FastISel、SelectionDAGISel 和 GlobalISel 产生的目标 Machine IR 通常仍然含有虚拟寄存器、目标伪指令和尚未最终确定的栈帧。三条路径之后还会进入共享的后端流程：

```text
目标 Machine IR
  ↓ Machine IR 优化、PHI 消除和指令约束处理
  ↓ Register Allocation
  ↓ 栈帧、序言/尾声、伪指令展开和后期调度
  ↓ MC lowering / AsmPrinter / Object Writer
汇编或目标文件
```

所以，严格地说，GlobalISel 负责的是从 LLVM IR 进入目标 Machine IR，而不是独自完成从 LLVM IR 到汇编的全过程。目标 Machine IR 之后的优化、物理寄存器分配和 MC 发射属于更广泛的 LLVM CodeGen，并由不同指令选择路径共享。

### 2.7 GCC 解决的是同一个问题，只是组织方式不同

GCC 从 GIMPLE 生成 RTL 时已经开始查询目标 machine description；后续又通过 combine、split、peephole、constraints 和 recognition，把 RTL 逐步变成能够匹配 `define_insn` 的形式。因此，GCC 并没有省略指令选择，而是把合法化、模式形成和目标约束分布在较长的 RTL 流程中。

```text
GCC：GIMPLE → 初始 RTL → combine/split/recognition → 最终 RTL → 汇编模板

LLVM GlobalISel：LLVM IR → gMIR → Legalizer → RegBankSelect
                 → InstructionSelect → 目标 MIR → MC
```

两者都在把目标无关操作逐步收紧为目标机器能够执行的形式。GlobalISel 为几个关键状态命名，并给每个阶段规定较明确的输出契约，因而便于分阶段测试和替换组件；GCC 则长期复用 RTL 这一类低层表示，目标决策更分散，但机器描述、combine、split 和约束处理已经积累多年。这里的区别主要是工程组织，不能只根据架构图判断哪一种方案全面更好。

## 3. 沿 GlobalISel 流水线展开实现细节

GlobalISel 进入 Machine IR 后，各阶段会在同一个 MachineFunction 上逐步补充目标约束。本节沿数据流依次说明 IR 翻译、合法化、寄存器库选择、目标指令选择以及失败归因中的关键实现细节。

### 3.1 IRTranslator：进入 Machine IR 不只是逐条改写

IRTranslator 把 LLVM IR 翻译为通用 MachineInstr，并建立 MachineFunction 中的基本块、虚拟寄存器和 use-def 关系。它通常通过 `MachineIRBuilder` 构造这些指令。`MachineIRBuilder` 不是一个 Pass，而是统一创建和插入 `MachineInstr` 的辅助接口；后面的 Legalizer、Combiner 和目标代码也会复用它，而不必各自手工拼装 `MachineOperand`。

普通算术可以直接形成 `G_ADD` 等通用操作，函数边界则必须同时处理 ABI。`CallLowering` 不是独立运行的 Pass，而是 IRTranslator 调用的目标接口。例如翻译 `call i32 @f(i32 %x)` 时，CallLowering 根据目标调用约定决定 `%x` 放入参数寄存器还是栈槽、返回值从哪里取回；IRTranslator 仍负责整个翻译过程。

一些 LLVM IR 也不能机械地一条换成一条 gMIR。聚合值可能包含多个字段、padding 和 undef 语义，进入 Machine IR 后通常要拆成多个低级类型和虚拟寄存器，由 `extractvalue`、`insertvalue` 等操作维护片段关系。`switch` 更会根据 case 分布变成 jump table、比较树、range 或 bit test；IRTranslator 会复用 SwitchCG 等控制流 lowering 逻辑创建新的 MachineBasicBlock。因此，GlobalISel 从第一步开始处理的就不只是 opcode 翻译，还包括表示拆分、ABI 和 CFG 构造。

### 3.2 Legalizer 与 Combiner：建立目标可处理的操作形状

IRTranslator 允许先忠实保留 LLVM IR 的通用语义，Legalizer 再判断当前 opcode、低级类型和内存描述是否受目标支持。不合法的操作可能被扩宽、拆分、替换或降低为其他通用操作；Pre/Post-Legalizer Combiner 则在合法化前后整理 gMIR，使等价操作形成更适合后续处理的形状。

这种职责划分是一种默认契约，不是不可跨越的能力边界。如果一个非法通用操作正好对应某条目标指令，先把它展开成若干合法通用操作，反而可能破坏最合适的目标模式。目标后端可以在自定义 legalization 中直接生成目标指令，也可以通过目标 Combiner 保留、重组或恢复 InstructionSelect 需要的形状。

灵活性同时带来 phase-ordering 问题：同一段语义经过不同的合法化规则会形成不同的 gMIR；InstructionSelect 只能匹配最终收到的形状。如果 Legalizer 过早拆散目标模式，而后续没有 Combiner 恢复，目标即使拥有合适的机器指令，selector 也可能无法使用。常规规则因此按照阶段契约组织，便于复用、测试和定位失败；只有特殊 lowering 或模式保留需求才穿过边界。

### 3.3 RegBankSelect：先确定寄存器体系，不分配物理寄存器

操作形状合法后，RegBankSelect 为虚拟寄存器确定粗粒度 Register Bank，例如 GPR、FPR，或 AMDGPU 的 SGPR、VGPR。InstructionSelect 随后根据目标指令施加更具体的 Register Class；Register Allocation 最后才选择具体物理寄存器并处理 spill/reload：

```text
RegBankSelect：GPR / FPR / SGPR / VGPR 等粗粒度寄存器库
InstructionSelect：GPR32 / GPR64 / VGPR_32 等具体合法集合
Register Allocation：映射到具体物理寄存器，并处理 spill/reload
```

仍以 AMDGPU 的 `G_ADD s32` 为例：如果操作数是 divergent，RegBankSelect 可以把相关虚拟寄存器放入 VGPR bank；InstructionSelect 随后选择 `V_ADD_U32_*`，并把结果约束到 `VGPR_32` class；Register Allocation 最后根据整个函数的活跃区间和冲突关系选择 `$vgpr7` 等物理寄存器，或者在寄存器不足时插入 spill/reload。

因此，RegBankSelect 虽然不是寄存器分配，却会影响后续可选指令、跨 bank copy 和寄存器压力。物理寄存器分配还要同时考虑固定寄存器、调用约定、复制合并和整个函数的活跃区间，是后续更完整的资源分配问题。

### 3.4 InstructionSelect：从合法 gMIR 覆盖到目标指令

InstructionSelect 接收已经合法并带有 Register Bank 约束的 gMIR。目标 selector 通常以某条通用指令为匹配根，检查 opcode、类型、操作数和 subtarget feature，沿 use-def 链覆盖相关 producer，然后生成一条或多条目标指令。

这个过程同时包含三件相关但不同的工作：选择目标 opcode 或指令序列；把常量、地址计算等 producer 折叠进目标模式；根据目标指令为虚拟寄存器增加 Register Class 约束。

例如，gMIR 中可能先计算地址，再执行加载：

```text
%addr:_(p0) = G_PTR_ADD %base, 24
%val:_(s32) = G_LOAD %addr
```

selector 可以以 `G_LOAD` 为匹配根，沿 use-def 链找到只被这里使用的 `G_PTR_ADD`，确认偏移 `24` 能编码进目标 load 的寻址字段，然后直接生成类似 `LDR ... [base, #24]` 的目标指令。一次匹配由此完成 load opcode 的选择、地址计算的折叠，以及对 base 和结果寄存器的 Register Class 约束。

这里的 use-def 折叠属于选择期的局部模式覆盖，不等同于独立 Combiner Pass，也不是硬件层面的 macro-fusion；增加 Register Class 约束同样不等于已经完成物理寄存器分配。

### 3.5 TableGen 与手写 C++：两种 selector 规则实现方式

简单模式可以由后端在 `.td` 文件中声明，再由 TableGen 生成 matcher。例如 `G_ADD s32` 到 AArch64 `ADDWrr` 这种 opcode、类型和操作数关系固定的映射，就适合写成声明式 pattern。GlobalISel 也能导入一部分既有 SelectionDAG pattern，但 ComplexPattern、自定义 SDNode 和部分 PatLeaf 不能无成本迁移。

复杂寻址、立即数判断、目标 pseudo、intrinsic 或多指令生成则可能使用手写 C++。如果一个 AMDGPU intrinsic 的选择取决于多个立即数、subtarget feature、操作数是否 uniform，以及特殊 tuple 约束，后端往往需要在 C++ 中检查条件并构造结果。

TableGen 和手写 C++ 是同一个 InstructionSelect 阶段中的两种规则实现方式，程序不会先经过“TableGen Pass”再经过“C++ Pass”。2015 提案也没有排除 TableGen 或 InstCombine，只是原型阶段没有同时改进它们；后来的 pattern 导入和 `GICombineRule` 属于被推迟后继续建设的工作。

### 3.6 目标知识沿流水线分布，而不是集中在一个 TargetLowering Pass

`TargetLowering` 不是一个运行 Pass，而是一组目标知识和 hook。GlobalISel 已经把 ABI、合法性、寄存器体系和目标指令选择分别交给 CallLowering、LegalizerInfo、RegisterBankInfo 和 InstructionSelector，但这不意味着每一种目标知识都能严格归属于单个阶段。

例如，调用参数位置由 CallLowering 处理；一个操作是否应调用 libcall、某种变换的成本、combine 是否有利以及特殊寻址形式是否可用，仍可能由多个阶段查询公共 `TargetLowering` 或其他目标接口。2015 年提案设想拆分旧接口，当前实现已经按主要职责分开，但成本、libcall、combine 和部分 lowering 知识仍会跨阶段共享。

### 3.7 完整流水线还会插入辅助分析与变换

四个核心阶段只是职责骨架，真实流水线还会使用 CSE、KnownBits、Pre/Post-Legalizer Combiner、常量处理和目标专用 lowering。`Localizer` 是其中一个独立的 `MachineFunction` Pass：它把适合重新物化的常量移近使用点，以缩短虚拟寄存器的 live range。

例如，入口块创建的常量如果只在两个远端基本块使用，Localizer 可以在使用点附近重新建立它，避免同一个虚拟寄存器贯穿大段 CFG。它改变的是值的放置位置和活跃范围，不负责把常量最终选择成哪条目标指令。区分核心阶段、辅助 Pass 和构建接口，才能避免把 GlobalISel 误解为只有四次遍历，或把所有内部组件都当成独立 Pass。

### 3.8 显式阶段使测试和 fallback 归因成为可能

GlobalISel 的中间状态都保存在 MIR 中，因此可以在特定阶段停止并保存结果，再单独重跑某个 MachineFunction Pass。常用工具包括：

- `-stop-after=ir-translator`：保存 IRTranslator 之后的 gMIR；
- `-run-pass`：隔离运行指定的 Machine IR Pass；
- `-simplify-mir`：缩减 MIR 复现用例；
- `-debug`、`-print-after-all`：观察各阶段内部状态；
- `update_llc_test_checks.py`、`update_mir_test_checks.py`：维护 FileCheck 预期；
- `llvm-tblgen --stats` 和 `--warn-on-skipped-patterns`：检查声明式 pattern 的导入情况。

例如，可以先把一个 LLVM IR 用例停在 IRTranslator 之后，再只运行 Legalizer：

```bash
llc -global-isel=1 -stop-after=ir-translator input.ll -o after-irtranslator.mir
llc -run-pass=legalizer after-irtranslator.mir -o after-legalizer.mir
llc -run-pass=reg-bank-select after-legalizer.mir -o after-regbankselect.mir
```

如果问题在第二条命令就出现，可以直接检查 Legalizer 前后的 `G_*` 操作和 LLT，而不必每次从 LLVM IR 一直跑到汇编。准备好满足前置属性的 MIR 后，也可以用 `-run-pass=instruction-select` 单独验证 matcher。

这套阶段契约同时定义了失败位置。一个函数只要在 IRTranslator、Legalizer、RegBankSelect 或 InstructionSelect 中遇到未覆盖的有效输入，就可能把当前 MachineFunction 标记为 `failedISel`；启用 fallback 时，LLVM 会重置该函数并改走 SelectionDAG，而不是只替换失败的单条指令。因此，GlobalISel 是否“完整”还取决于目标是否保留其他选择路径，以及采用中止、诊断还是回退策略。

`-global-isel-abort=0` 会静默回退，适合产品路径；`=1` 在失败时中止，适合暴露缺口和生成复现；`=2` 保留回退但输出诊断，适合覆盖率统计。最终能够生成汇编，只能证明 fallback 之后的完整编译成功，不能证明 GlobalISel 独立完成了选择。后面的测试台正是利用这一差别，把“编译成功”和“GlobalISel 成功”分开记录。

## 4. 三个仍待回答的问题

### 4.1 函数级视野究竟换来了什么

SelectionDAGISel 以基本块级 DAG 为主要工作单元，GlobalISel 则从 IRTranslator 开始就在完整 MachineFunction 上维护 Machine IR。函数级表示提供了跨基本块分析和变换的可能，但“能够看到”并不等于“真正使用”，也不等于最终代码自然更好。

> GlobalISel 的函数级视野究竟转化出了多少跨基本块代码质量收益？如果这些收益没有出现在最终代码中，它们是在 combine、合法化、寄存器库选择、指令选择，还是后续寄存器压力处理中消失的？

### 4.2 没有完整 MachineModule，“Global”能够走多远

GlobalISel 的函数级作用域比基本块更大，但 LLVM 没有一套与 LLVM IR Module 对称、普遍供机器层 Pass 分析和变换的完整 MachineModule IR。MachineModuleInfo 和特殊 ModulePass 可以解决部分需求，却不等于机器层始终拥有统一的模块级表示。

> 缺少完整 MachineModule 是否真正限制了跨函数机器优化？还是说，大多数跨函数工作本来就应该留在 LLVM IR、LTO 或链接阶段，而逐函数 CodeGen 才是更合理的边界？

### 4.3 显式阶段一定比连续收紧更好吗

GlobalISel 把翻译、合法化、寄存器库选择和目标指令选择定义成显式阶段；GCC 则在 RTL 生成、combine、split、recognition、约束处理和寄存器分配中持续收紧低层表示。两者解决的是同一类问题，只是工程组织方式不同。

> LLVM 的显式阶段契约是否真的带来了更好的可测试性、可维护性和代码质量？它会不会同时引入更多表示转换和 phase-ordering 问题？GCC 长期复用 RTL 的方式又在哪些场景更简单，哪些场景更难定位问题？

## 5. fallback：从迁移保障到待解决问题的记录

### 5.1 为什么早期实现需要 fallback

GlobalISel 并不是等所有能力都补齐以后，再一次性替换原有 selector。[2015 年的原始提案](https://lists.llvm.org/pipermail/llvm-dev/2015-November/092566.html)把这项工作拆成了多个里程碑：先完成基础翻译、简单选择和合法化，再处理产品化、复杂合法化、完整覆盖以及代码质量问题。这样做可以让新流水线尽早进入真实编译环境，但也带来了一个直接问题：尚未支持的函数怎么办？

[GlobalISel 官方文档](https://llvm.org/docs/GlobalISel/index.html#fastisel-replacement)给出的办法是回退到 SelectionDAG。一个函数如果没能走完 GlobalISel，LLVM 就重置对应的 MachineFunction，再由 SelectionDAG 重新完成整个函数的指令选择。LLVM 也考虑过在运行前判断某个函数是否受 GlobalISel 支持，但这几乎等于提前模拟一遍 IRTranslator，而且仍然防不住没有预料到的失败。

所以 fallback 最初是一张安全网。GlobalISel 可以在覆盖尚不完整时开始接受实际代码的检验；遇到暂时处理不了的函数，SelectionDAG 仍能把编译继续完成。迁移不必等到所有缺口都消失以后才开始。

### 5.2 fallback 保证了编译成功，也遮住了剩余缺口

安全网并不是没有代价。GlobalISel 先运行、失败后再改走 SelectionDAG，最坏情况下会让同一个函数承担两套选指流程的开销。更麻烦的是，静默 fallback 会让一次成功的编译变得不好解释：看到最终汇编，只能确定两条路径中至少有一条成功，无法知道 GlobalISel 是否独立完成了任务。

因此，在 SelectionDAG 基线能够成功、目标也确实尝试了 GlobalISel 的前提下，每一次 fallback 都可以看作一条尚未完成的迁移记录。它表示 GlobalISel 在当前 LLVM 版本、目标配置和编译选项下没有走完整条流水线，仍有一部分工作需要 SelectionDAG 兜底。

不过，一条记录不能直接算作一个独立 bug。fallback 的单位是函数，许多函数可能重复触发同一个缺口；失败也不一定发生在 InstructionSelect，还可能来自 IRTranslator、Legalizer 或 RegBankSelect。要知道究竟还剩多少问题，不能只数 fallback 次数，还需要记录失败阶段并做归并。

[2022 年 Apple AArch64 默认启用 RFC](https://discourse.llvm.org/t/enabling-globalisel-for-apple-aarch64-platforms/63953)很好地说明了这一点。受控测试中的 fallback 已经降到约 1%，提案仍然保留了 SelectionDAG fallback 和显式退出选项。默认启用补丁后来合入，却在四天内因为 test-suite crash、LTO assertion/miscompile 和默认配置不一致等问题回滚。截至 2026 年 11 月 7 日，LLVM 主线的 `EnableGlobalISelAtO` 默认值仍为 `0`，也就是 AArch64 默认只在 `CodeGenOptLevel::None`（通常对应 `-O0`）使用 GlobalISel，`-O1` 及以上没有完成默认切换。[AArch64TargetMachine.cpp](https://github.com/llvm/llvm-project/blob/main/llvm/lib/Target/AArch64/AArch64TargetMachine.cpp)

这件事至少说明，fallback 比例很低和迁移完成不是一回事。只检查最终能不能编译，会漏掉那些已经被 SelectionDAG 接住的问题。要继续推进 GlobalISel，就得把这些失败单独暴露出来，并且持续观察。

### 5.3 2025 年的 CI/CD 原型，以及我们为什么重新做了一次

沿着这个思路，[2025 年 LLVM Developers' Meeting 的 GlobalISel CI/CD 演讲](https://llvm.org/devmtg/2025-10/slides/lightning_talks/hickey.pdf)展示了一套内部系统：每天更新 LLVM 主线、编译 benchmark、收集 fallback，再按照 IRTranslator、Legalizer、RegBankSelect 和 InstructionSelect 分类。系统还提供历史趋势、benchmark、函数和失败阶段等视图。原本会被 SelectionDAG 静默接住的问题，因此有了一份可以持续查看的记录。

不过，这套系统当时并不是 LLVM 社区已经可以直接使用的公共设施。演讲把开源放在了 future direction：如果社区有足够兴趣，再开放代码，让其他人增加 benchmark、配置和数据库视图。截至本次实验开展时，我们没有找到可直接复用的公开仓库、长期 dashboard 或 LLVM 上游 CI 集成。这个检索结果只能说明公开设施仍然缺位，不能用来判断那套内部系统后来是否继续运行。

演讲公开的数据也不足以继续做根因分析。它没有给出完整的函数分母、原始事件、稳定的归一化规则或可重放的最小例子；同一个原因还可能在很多函数中反复出现。因此，其中的 133 个 fallback event 只能说明缺口仍然存在，不能直接理解成 133 个独立问题。

我们据此在 AMDGPU 上重新做了一次尝试：使用公开语料和固定工具链建立统计流程，同时保留 case 分母、函数级事件、失败阶段、归一化签名和 reduced artifact。下一节会继续说明这些数据为什么都要保留，以及怎样避免把无效输入、重复事件和独立问题混在一起。

## 6. AMDGPU GlobalISel fallback 实测

### 6.1 怎么测试

我们选取了两组公开语料：`llvm/test/CodeGen/AMDGPU` 中的 3,590 个 LLVM IR 文件，以及 ROCm Examples 中的 92 个 HIP 文件。它们分别在 `gfx900`、`gfx1030` 和 `gfx1100` 上测试；LLVM IR 使用 `-O2`，HIP 同时测试 `-O0` 和 `-O2`，总共展开成 11,322 个 case。

每个 case 先运行 SelectionDAG。只有 SelectionDAG 能够成功生成结果，才继续强制运行 GlobalISel，并打开显式 fallback 诊断。这样可以避免把输入本身、目标参数或测试调用方式的问题误算成 GlobalISel 缺口。

对发生 fallback 的 case，测试台继续提取函数名、失败阶段、原因、opcode、类型和 register bank。相似事件被归入同一个候选签名，每个签名再选择代表输入进行约简和重放。整个实验固定 LLVM、ROCm、目标 GPU 和优化参数，不需要真实 GPU。

测试台代码、固定配置、脱敏后的汇总数据以及可重放的 reduced artifact 已发布在 [amdgpu-gisel-fallback-study](https://github.com/jinmoza/amdgpu-gisel-fallback-study)。

### 6.2 测试结果

11,322 个计划 case 的处理结果如下：

| 分类 | case 数 | 含义 |
|---|---:|---|
| HIP 前端编译失败 | 90 | 对应 15 个 HIP 源文件，未进入后端比较 |
| SelectionDAG 基线未通过 | 4,191 | 统一调用无法建立基线，未计入 GlobalISel 统计 |
| GlobalISel 成功 | 6,095 | GlobalISel 独立完成指令选择 |
| GlobalISel fallback | 885 | 至少有一个函数回退到 SelectionDAG |
| GlobalISel 崩溃或异常退出 | 61 | 已单独记录，未算作 fallback |
| 合计 | 11,322 | — |

真正进入 GlobalISel 对照的共有 7,041 个 case，其中 885 个发生 fallback，case 级 fallback 率为 **12.57%**。

885 个 fallback case 中一共提取出 6,111 个函数级 fallback 事件。按第一个失败阶段分类如下：

| 失败阶段 | 函数事件 | 候选签名 |
|---|---:|---:|
| RegBankLegalize | 5,033（82.36%） | 60 |
| IRTranslator | 560（9.16%） | 1 |
| Legalizer | 512（8.38%） | 43 |
| InstructionSelect | 6（0.10%） | 3 |
| 合计 | 6,111 | 107 |

自动归并最终得到 107 个候选签名，其中 104 个已经生成并验证了可重放的 reduced artifact。107 不是已确认的独立 bug 数；它只是把 6,111 个函数事件压缩成较小的调查范围。

事件分布也非常集中。最大的两个签名都与 `G_INTRINSIC_W_SIDE_EFFECTS` 的 VGPR 约束有关，共覆盖 4,428 个函数事件，占全部 fallback 的 **72.46%**。因此，当前最突出的问题不在最终 InstructionSelect，而在 RegBankLegalize，也就是通用 gMIR 与 AMDGPU 寄存器 bank 约束衔接的位置。

## 关于经验范围与内容准确性的说明

我目前对 SelectionDAG 和 GlobalISel 的实际开发、调试经验还不丰富。本文前半部分的概念介绍和部分判断，主要来自对官方文档、提案、社区讨论和源码的阅读，并由 AI 协助整理。虽然整理过程中尽量使用源码和本地实验交叉核对，但仍可能存在理解偏差、过度概括或事实错误。

因此，这是一份会随着实践持续修订的研究记录，而不是权威指南。后续在实际调试、修改 LLVM 和参与社区工作的过程中，如果发现文中的认识与实现不符，我会随时修改；也欢迎读者指出问题、补充资料或提供可以复现的反例。

