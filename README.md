# dsh-plugin-photoshop

让 DeepSeek Harness 里的 AI **直接驱动你本机的 Adobe Photoshop**：批量抠图、批量跑脚本，不用你手动一张张点。

[![Topic](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

**简体中文** · [English](README_EN.md)

---

## 它解决什么问题

想从一段视频里抽帧、再把画面里的人物抠出来当素材时，Photoshop 的「选择主体」比开源抠图模型准得多，但 AI 助手够不到你电脑上的 Photoshop，只能你自己一张张手动做。

装上这个插件之后，你只要说一句：

> 把 `D:\frames` 里所有图抠出人物，输出到 `D:\cutouts`

AI 就会调用本机 Photoshop 把整批做完，产出**带透明通道的 PNG**，并逐张报告结果。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows（用 COM 自动化接口，macOS / Linux 不支持） |
| Photoshop | 任意现代版本（本插件在 Photoshop 2026 / 27.0 上完整验证过）；「选择主体」需要 Photoshop 2020 及以上 |
| Node.js | 20 或更高（DSH 本体已要求） |
| 其他 | 无需 ffmpeg、无需 Python、无第三方依赖 |

## 安装

```bash
dsh plugin --profile web add dsh-plugin-photoshop
```

从 GitHub 源码安装（未发布到 npm 时）：

```bash
dsh plugin --profile web add git+https://github.com/<你的用户名>/dsh-plugin-photoshop.git
```

装完**重启 `dsh web`** 即生效。插件是常驻的：之后每个新会话都能用。

卸载：

```bash
dsh plugin --profile web remove dsh-plugin-photoshop
```

## 七个工具

### `photoshop_status`

环境自检。只读，不打开也不修改任何文件。

报告 Photoshop 版本与 build、是否已经在运行、当前打开了哪些文档、这个版本有没有「选择主体」和「移除背景」命令。**当 Photoshop 相关操作莫名失败时，先跑它。**

### `photoshop_inspect`

读取当前屏幕上的真实状态。只读。

报告每个打开的文档，以及其中一个的：尺寸、分辨率、色彩模式、位深、色彩配置文件、磁盘路径、是否有未保存修改、当前活动图层、选区范围、历史记录位置、通道/路径/参考线数量。

然后是**完整的图层树**，每个图层都会带上：索引路径、名称路径、类型、可见性、不透明度、填充不透明度、混合模式、是否剪贴蒙版、是否有蒙版、是否有矢量蒙版、是否有图层样式、是否背景层、边界范围；文字图层还会读出内容、字号、字体和对齐方式。

图层用**两种方式**标识，方便后续操作引用：

- **索引路径** `0.1` —— 第一个组里的第二个图层
- **名称路径** `Header/Title` —— 就是你平时嘴上说的那个名字

**为什么先做这个**：现实中几乎每个需求都是相对于已经打开的东西说的——"把背景层换成蓝色"、"把这个组里所有图层导出"。没有这一步，AI 只能猜图层名，而猜就是它不可靠的根源。

### `photoshop_cutout` —— 主力工具

批量抠图。整批在**同一个 Photoshop 会话内**处理完，而不是每张图来回一次，几百张图的场景下速度差一个数量级。

| 参数 | 说明 |
| --- | --- |
| `paths` | 必填。图片文件或文件夹（可混用、可多个） |
| `output_dir` | 必填。输出目录，不存在会自动创建 |
| `mode` | `select-subject`（选择主体，默认）或 `remove-background`（移除背景） |
| `recursive` | 是否递归扫描子文件夹，默认否 |
| `trim` | 是否裁掉透明边距让人物贴边，默认**是** |
| `feather_px` | 边缘羽化像素数，默认 0（保留「选择主体」自带的抗锯齿） |
| `contract_px` | 抠图前把选区收缩几像素，**丢掉主体原来压着的那圈背景**——这是消除彩色描边最有效的手段，也是 Photoshop「修边」菜单无法脚本化时的替代方案。默认 0 |
| `mask_blur_px` | 抠图后对图层蒙版做模糊，进一步柔化轮廓。默认 0。这是「选择并遮住」无法无头运行时的替代方案 |
| `max_side` | 最长边限制，超过则等比缩小，默认 0（保持原尺寸） |
| `suffix` | 输出文件名后缀，默认无 |
| `overwrite` | 是否覆盖已存在的输出，默认否（跳过并说明） |
| `limit` | 本次最多处理几张，用来先试几张看看效果 |
| `timeout_ms` | 整批的时间预算，几百张图时请调大 |

输出为 **PNG-24 带 alpha**，文件名默认沿用原文件名。

**每一张输出都会校验 PNG 头里的 alpha 通道**——如果一个文件其实没有变透明，报告会直接写 `NO ALPHA` 并提示改用 `remove-background`，不会让一个假成功的文件混过去。

**而且会测量边缘质量。** 插件会真正解码 PNG、统计 alpha 通道的分布：完全透明、完全不透明、以及**部分透明**各有多少像素。部分透明的像素数就是轮廓上那条软过渡带的宽度——于是"边缘变好了"从一句主观判断变成了一个数字。同一张图，加上 `feather_px: 2, contract_px: 1, mask_blur_px: 1` 之后：

| 抠图 | 部分透明像素 | 过渡带占比 |
| --- | --- | --- |
| 未优化 | 1,271 | 0.75% |
| 优化后 | **12,637** | **7.36%** |

过渡带宽了约十倍，而这个数字是测试跑出来的，不是我说的。

示例：

> 把 `D:\frames` 和 `D:\more\a.jpg` 一起抠图，输出到 `D:\cutouts`，先试 5 张，边缘羽化 1 像素，最长边限制 1200

### `photoshop_batch` —— 批量生产

把**同一套操作**跑在一批文件上，整批在**一个 Photoshop 会话内**完成。

| 参数 | 说明 |
| --- | --- |
| `paths` | 必填。图片文件或文件夹 |
| `ops` | 必填。对每个文件执行的操作列表（与 `photoshop_apply` 同一套词汇） |
| `output_dir` | 必填。结果输出目录 |
| `output_format` | `png`（默认，唯一保留透明度）、`jpeg`、`psd`、`tiff` |
| `suffix` | 输出文件名后缀 |
| `overwrite` | 是否覆盖已存在的输出，默认否 |
| `recursive` | 是否递归子文件夹 |
| `limit` | 本次最多处理几个文件 |

每个文件都是**打开 → 执行计划 → 存到输出目录 → 不保存关闭**，所以原图永远不会被改写。单张失败会被记录下来，**批次继续往下跑**——一个坏帧就中断整批，对生产毫无用处。

计划里**不允许**出现 `open`、`new_document`、`close`、`save_as`——打开、保存、关闭由批次自己负责。带了会被明确拦下并说明原因（`save_as` 尤其危险：它会让每个输入都写到同一个路径）。

### `photoshop_apply` —— 通用操作

把一串**具名操作**按顺序作用于已打开的文档。这是插件的通用手：文档设置与缩放、图层的新建/命名/排序/编组、蒙版、不透明度、混合模式、图层样式、色调与色彩调整、滤镜、文字、填充、选区、历史、元数据。

**当前共 93 个操作**，分九组：

| 组 | 数量 | 覆盖 |
| --- | --- | --- |
| `document` | 16 | 打开/新建/关闭/另存、缩放、画布、裁剪、旋转、翻转、裁边、拼合、合并、复制、色彩模式、配置文件、导出图层 |
| `layer` | 23 | 新建/删除/复制/重命名/移动/编组/解组、不透明度、填充不透明度、混合模式、可见性、锁定、解锁背景、栅格化、智能对象、向下合并、蒙版增删应用反相**与边缘柔化**、剪贴蒙版、图层样式 |
| `adjust` | 12 | 色阶、亮度对比度、色相饱和度、自然饱和度、黑白、去色、反相、阈值、色调分离、色调均化、自动色阶、自动对比度 |
| `filter` | 20 | 高斯/动感/径向/特殊模糊、USM 锐化、锐化×3、添加杂色、蒙尘划痕、中间值、去斑、高反差保留、最大值、最小值、位移、自定义滤镜、挤压、球面化、旋转扭曲 |
| `select` | 14 | 全选/取消/反选/清除、选择主体、选择天空、移除背景、扩展、收缩、羽化、平滑、边界、存储/载入选区 |
| `paint` | 4 | 新建文字、修改文字、填充、添加纯色图层 |
| `action` | 1 | 列出动作面板（**播放被刻意移除**，原因见路线图） |
| `history` | 2 | 后退一步、前进一步 |
| `metadata` | 1 | 写入文档元数据 |

两个让它可靠的设计：

- **整组计划是一个 undo 步。** 在已有文档打开时，整串操作用 `suspendHistory` 包起来，用户按一次 Ctrl+Z 就撤销 AI 做的所有事。计划本身要和历史打交道时（`step_backward`）可以关掉这个包装。
- **执行前先在本地校验计划。** 拼错的操作名不会白跑一趟 Photoshop，而是当场返回 `Unknown operation "gausian_blur". Did you mean gaussian_blur, …`。

失败的汇报也是有用的：它告诉你**第几个操作**、**操作名**、**错误原因**、**已经成功应用了哪些**，以及撤销一次能不能全退回去。

### `photoshop_reference`

按需返回操作词汇表（可只取一组）。不启动 Photoshop，也不需要文档。常驻提示词里只保留一句"需要时去查它"，模型照样能学到全部能力。

### `photoshop_run_jsx`

逃生舱：在 Photoshop 里执行任意 ExtendScript 并返回结果。

批量改尺寸、应用录制好的动作（.atn）、合成图层、读取文档信息……任何 Photoshop 能脚本化的事都能做，不必等插件内置对应功能。

```
photoshop_run_jsx(script: "app.activeDocument.resizeImage(UnitValue(800,'px'))\n'resized'")
```

## 附带一个技能

插件还会注册一个名为 **`photoshop`** 的技能，装着"怎么把 PS 用对"的整套工作方法：调用顺序、图层寻址、不伤用户文件的红线、以及这个版本上那些反直觉的坑（新图层是全透明的、背景层要先解锁、图层组不能填充、选择并遮住无法无头运行，等等）。

它是**按需加载**的，所以常驻提示词里只有一句"做非平凡的 PS 工作前先加载它"，模型需要时再读全文。

## 安全性

这个插件会操作你真实的 Photoshop，所以设计上刻意保守：

- **只操作它自己打开的文档**。你手动打开的文件永远不会被关闭。
- **永远不保存回原图**。所有文档都以「不保存」关闭，输出只写到你指定的输出目录。
- **不改你的 Photoshop 偏好**。脚本执行期间会临时抑制弹窗（否则会卡死自动化），结束后立刻恢复原值。
- **覆盖需显式授权**。输出文件已存在时默认跳过并提示，只有传 `overwrite: true` 才会覆盖。
- **可中断**。批处理每张图之间会检查取消标记，被取消时已完成的部分仍会完整汇报。

## 工作原理

Photoshop 在 Windows 上注册了一个版本无关的 COM 自动化服务 `Photoshop.Application`，它暴露了 `DoJavaScript()`，可以在这台正在运行的 Photoshop 里执行 ExtendScript 并取回结果。所以整条链路是：

```
Node（插件）
  └─ powershell.exe -File runner.ps1
       └─ New-Object -ComObject Photoshop.Application
            └─ DoJavaScript(生成的 ExtendScript)
                 └─ 真正的 Photoshop
```

几点实现取舍：

- **参数用 JSON 字面量直接嵌进生成的脚本**。JSON 是 JavaScript 字面量的子集，因此不需要任何转义层或 base64 中转。
- **结果走文件、不走控制台**。Windows PowerShell 的控制台按代码页编码，非 ASCII 路径和报错信息会被搞乱；所有结果都由 ExtendScript 自己以 UTF-8 写文件。
- **整批一个脚本**。一次 COM 往返处理完整批，而不是每张图一次。
- **零依赖**。插件不 import 任何 `@deepseek-ai/*` 框架包，只用 Node 标准库，因此不会因为不同安装器 / 包管理器的依赖提升布局而加载失败。

抠图的正确姿势也是实测出来的：Photoshop 的「选择主体」命令是 `autoCutout`（`selectSubject` 这个 action ID 在本版本里会报「命令当前不可用」）；抠图需要先把背景层解锁（`isBackgroundLayer = false`）才能清除像素，否则反选后的删除会失败。

## 常见问题

**报告 `PHOTOSHOP_UNAVAILABLE`**
这台机器上找不到 Photoshop，或者 COM 服务没注册。确认 Photoshop 能正常启动。

**报告 `Photoshop did not answer within the time budget`**
批次太大，或者 Photoshop 本来没开、被这次调用冷启动（冷启动可能要一分钟以上）。调大 `timeout_ms`。

**某张图报 `Select Subject found no subject in this image`**
Photoshop 的 AI 在这张图里没找到主体。换 `mode: "remove-background"` 试试，或确认画面里确实有人/主体。

**输出文件 `NO ALPHA`**
抠图没有真正生效，画面内容仍然是不透明的。改用 `remove-background` 模式重跑这些图。

**超过 `--profile web` 的其他 profile**
把命令里的 `web` 换成你要装的那个 profile 名即可。

## 开发

```bash
git clone https://github.com/<你的用户名>/dsh-plugin-photoshop.git
cd dsh-plugin-photoshop
node test/e2e.mjs                 # 会对真实 Photoshop 跑一次完整验证
node test/probe-capabilities.mjs  # 反射枚举本机 PS 的真实 API 表面
node test/probe-operations.mjs    # 逐项真实执行，产出能力矩阵
```

`test/e2e.mjs` 会构建工具定义、注册到替身注册表、然后像工具运行时那样调用它们的 `execute`——覆盖除 Cordis 本体以外的全链路，并用 PNG 头验证每张输出的 alpha 通道，以及用一个真实夹具文档（含图层组、嵌套文字图层、带蒙版的像素图层）验证 `photoshop_inspect` 报告的每一项事实。测试输入取自 `~/Pictures/1.jpg`（也可以传一张自己的图作为参数），产物落在 `_research/e2e/` 供肉眼检查；每次运行都会先清空输出目录，因此可以反复运行。

两个探针是**能力清单的依据**：反射给出本机真实存在的 API 表面，执行矩阵逐项验证"到底能不能跑"。新增能力时先让它在矩阵里变成 `ok`，再写进文档。

也可以直接把本目录装进 profile 做开发：

```bash
dsh plugin --profile web add "F:\路径\到\dsh-plugin-photoshop"
```

## 许可

[MIT](LICENSE)
