---
title: LLVM AMDGPU：修复 MFMA scale verifier 的 Src1 format 诊断关联
published: 2026-11-01
description: 修复 LLVM AMDGPU IR verifier 在报告 MFMA scale Src1 向量宽度错误时关联了错误 format 参数的问题。
tags:
  - LLVM
  - AMDGPU
  - 编译器
  - Verifier
lang: zh
abbrlink: llvm-amdgpu-mfma-src1-format-diagnostic
---

## 摘要

LLVM 的 AMDGPU IR verifier 在检查 MFMA scale intrinsic 时，能够正确判断 Src1/B 向量是否满足 B format 的宽度要求，但失败诊断附带了错误的参数：检查依据是参数 4 `BLGP`，打印的却是参数 5——A scale 的 `op_sel`。

本次修复把诊断上下文改为参数 4，并强化既有 verifier 回归测试，使参数 4 与参数 5 取不同常量，从而真正验证错误关联的是 B format。修改只影响非法 IR 的诊断对象，不改变 IR 的接受或拒绝结果，也不触及 intrinsic ABI、AMDGPU lowering、指令选择或机器码。

## 上游交付

- LLVM PR：[llvm/llvm-project#237737 — AMDGPU Fix MFMA Src1 format diagnostic](https://github.com/llvm/llvm-project/pull/237737)
- 完整补丁：[PR #237737 Files changed](https://github.com/llvm/llvm-project/pull/237737/files)
- 对应提交：[`92564a6a1082`](https://github.com/jinmoza/llvm-project/commit/92564a6a1082963af94676f03e7761c87d51f8d1)

## 问题所在层级

该检查位于 `llvm/lib/IR/VerifierAMDGPU.cpp`，属于 LLVMCore 中的 LLVM IR verifier，而不是 AMDGPU lowering、MachineVerifier 或 `llvm-mc`：

```text
LLVM IR Parser
  -> LLVM IR Verifier
     -> AMDGPU intrinsic 专用检查  <- 问题位于这里
  -> AMDGPULowerIntrinsics
  -> SelectionDAG / GlobalISel
  -> Machine IR / MC
```

`llvm-as`、`opt` 和 `llc` 都会在正常流程中触发 IR 验证。非法调用会在进入 AMDGPU CodeGen 前被拒绝，因此这里的错误不会传播成错误指令；它的问题是把无关参数展示给开发者，误导对非法向量宽度的定位。

## 参数语义与不一致

MFMA scale intrinsic 中与本问题相关的参数是：

| 参数编号 | 含义 | 是否决定源向量宽度 |
| ---: | --- | --- |
| 0 | Src0 / A | 被检查对象 |
| 1 | Src1 / B | 被检查对象 |
| 3 | `CBSZ`，A format | 决定 A 所需宽度 |
| 4 | `BLGP`，B format | 决定 B 所需宽度 |
| 5 | A scale `op_sel` | 与 B 宽度无关 |

Src0/A 的检查是自洽的：宽度由参数 3 `CBSZ` 决定，诊断也附带参数 3。Src1/B 的判定同样正确使用了参数 4 `BLGP`，但诊断上下文错误地取了参数 5：

```cpp
Check(Src1Ty->getNumElements() >= GetFormatNumRegs(BLGP),
      "invalid vector type for format", &Call, Src1,
      Call.getArgOperand(5));
```

因此这是一个明确的 operand index 错误，而不是 format 语义或宽度规则存在歧义。

## 可区分的最小复现

要证明诊断究竟引用了哪个参数，必须让参数 4 和参数 5 的值不同。例如让 B 为 `<4 x i32>`，同时设置：

```llvm
; 参数 4：BLGP = 0，B format 为 FP8，要求至少 8 个元素
; 参数 5：A scale op_sel = 2，与 B 宽度无关
call ...(<8 x i32> %a, <4 x i32> %b, ..., i32 0, i32 0, i32 2, ...)
```

此时 verifier 拒绝 IR 是正确的，因为 `4 < 8`。修复前，诊断最后打印 `i32 2`，也就是无关的参数 5；正确结果应打印 `i32 0`，即实际决定 B 宽度的参数 4。

Src0/A 可以作为对照：让 A 过窄且参数 3 与参数 5 不同，诊断会正确打印参数 3。A、B 两条路径的对照进一步排除了诊断框架本身选错对象的可能性，问题就在 Src1 `Check` 调用传入的最后一个 operand。

## 为什么既有测试没有发现

既有 `llvm/test/Verifier/AMDGPU/mfma-scale.ll` 已覆盖 Src1/B 过窄，但参数 4 和参数 5 都是 `i32 0`。无论实现取哪个参数，FileCheck 看到的最后一行都是 `i32 0`，因此测试只能确认“打印了一个零”，不能确认这个零来自 `BLGP`。

回归测试的关键不是再增加一个同类非法调用，而是制造参数来源的可观察差异：保留参数 4 为 `i32 0`，把参数 5 改为 `i32 1`，并继续要求诊断打印 `i32 0`。这样，未来若再次把诊断关联到参数 5，测试会立即失败。

## 修复与范围控制

最终代码修复只有一处：

```diff
 Check(Src1Ty->getNumElements() >= GetFormatNumRegs(BLGP),
       "invalid vector type for format", &Call, Src1,
-      Call.getArgOperand(5));
+      Call.getArgOperand(4));
```

同时审计了 `verifyAMDGPUIntrinsicCall()` 中同级的 operand-aware 检查：MFMA Src0、format 范围、WMMA A/B、cooperative atomic 和 AV metadata 的判定对象与诊断对象一致，未发现另一个同类的“条件使用 X、诊断打印 Y”错误。部分检查只附带完整 call，精度较低，但不属于本次参数关联错误。

范围因此保持为：一行生产代码修复，加一处能够区分两个参数的测试调整。没有顺手重构诊断框架，也没有把它并入此前的 #236362 lowering 修复。

## 验证结果

验证先以测试改动建立 RED：在生产代码未修复时，测试期望参数 4 的 `i32 0`，实际却打印参数 5 的 `i32 1`。修改 operand index 后同一测试转为 GREEN。

最终补丁通过：

- `llvm/test/Verifier/AMDGPU/mfma-scale.ll`：1/1；
- `llvm/test/Verifier/AMDGPU`：18/18；
- 完整 `llvm/test/Verifier`：444 PASS、10 UNSUPPORTED、0 FAIL；
- `git diff --check`；
- 独立 Codex review 与 code-simplifier 检查，未发现需要扩大的修改。

这个修复的核心经验是：诊断测试不仅要检查输出值，还要让候选 operand 具有不同的可观察值。只有这样，测试才能证明诊断关联的是正确语义来源，而不是偶然打印了相同常量。
