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

## 三个工具

### `photoshop_status`

环境自检。只读，不打开也不修改任何文件。

报告 Photoshop 版本与 build、是否已经在运行、当前打开了哪些文档、这个版本有没有「选择主体」和「移除背景」命令。**当 Photoshop 相关操作莫名失败时，先跑它。**

### `photoshop_cutout` —— 主力工具

批量抠图。整批在**同一个 Photoshop 会话内**处理完，而不是每张图来回一次，几百张图的场景下速度差一个数量级。

| 参数 | 说明 |
| --- | --- |
| `paths` | 必填。图片文件或文件夹（可混用、可多个） |
| `output_dir` | 必填。输出目录，不存在会自动创建 |
| `mode` | `select-subject`（选择主体，默认）或 `remove-background`（移除背景） |
| `recursive` | 是否递归扫描子文件夹，默认否 |
| `trim` | 是否裁掉透明边距让人物贴边，默认**是** |
| `feather_px` | 边缘羽化像素数，默认 0（保留 Photoshop 的硬边） |
| `max_side` | 最长边限制，超过则等比缩小，默认 0（保持原尺寸） |
| `suffix` | 输出文件名后缀，默认无 |
| `overwrite` | 是否覆盖已存在的输出，默认否（跳过并说明） |
| `limit` | 本次最多处理几张，用来先试几张看看效果 |
| `timeout_ms` | 整批的时间预算，几百张图时请调大 |

输出为 **PNG-24 带 alpha**，文件名默认沿用原文件名。

**每一张输出都会校验 PNG 头里的 alpha 通道**——如果一个文件其实没有变透明，报告会直接写 `NO ALPHA` 并提示改用 `remove-background`，不会让一个假成功的文件混过去。

示例：

> 把 `D:\frames` 和 `D:\more\a.jpg` 一起抠图，输出到 `D:\cutouts`，先试 5 张，边缘羽化 1 像素，最长边限制 1200

### `photoshop_run_jsx`

逃生舱：在 Photoshop 里执行任意 ExtendScript 并返回结果。

批量改尺寸、应用录制好的动作（.atn）、合成图层、读取文档信息……任何 Photoshop 能脚本化的事都能做，不必等插件内置对应功能。

```
photoshop_run_jsx(script: "app.activeDocument.resizeImage(UnitValue(800,'px'))\n'resized'")
```

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
node test/e2e.mjs          # 会对真实 Photoshop 跑一次完整批量抠图
```

`test/e2e.mjs` 会构建工具定义、注册到替身注册表、然后像工具运行时那样调用它们的 `execute`——覆盖除 Cordis 本体以外的全链路，并用 PNG 头验证每张输出的 alpha 通道。测试输入取自 `~/Pictures/1.jpg`（也可以传一张自己的图作为参数），产物落在 `_research/e2e/` 供肉眼检查。

也可以直接把本目录装进 profile 做开发：

```bash
dsh plugin --profile web add "F:\路径\到\dsh-plugin-photoshop"
```

## 许可

[MIT](LICENSE)
