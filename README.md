# 多语言演出播放内核（音频 + 字幕组合）

视频元素是唯一主时钟：MSE 视频分片驱动画面，独立音频轨通过 Web Audio 按清单
时间偏移做采样级调度，字幕以独立引擎按同一节目时间渲染。切换音轨不重置画面、
不让字幕回到开头；组合切换带单一确认版本，陈旧请求的结果不能形成混合配置。

## 目录结构

```
public/
  index.html               图形播放器（诊断台），不是只有脚本
  program.json             节目清单：视频/音频/字幕轨、选择与组合规则
  kernel/
    manifest.mjs            清单校验、默认选择、回退链、组合角色规则
    playback-kernel.mjs     对外门面：音轨/字幕/组合/seek，版本化切换
    audio-scheduler.mjs     Web Audio 分片调度，视频主时钟，音画漂移度量
    subtitle-engine.mjs     字幕分片加载与 cue 渲染，generation 防陈旧
    video-engine.mjs        MSE 视频引擎
    shard-loader.mjs        音频分片抓取/解码缓存
    ui.mjs                  由内核状态驱动的页面控件
  media/
    video-main/             fMP4 视频分片（画面烧录时间码比特，供测试读取）
    audio-<id>/             每语言/角色一个 WAV 分片目录，各自独立测试音
    subs-<id>/              字幕分片 JSON，cue 为绝对节目时间
tools/generate-media.mjs    重新生成全部媒体与 program.json
tests/
  kernel.spec.mjs           原有音频行为回归（9 例）
  combinations.spec.mjs     字幕与组合能力（16 例）
  helpers.mjs               测试辅助（启动、时间码、音调、路由延迟）
```

## 轨道与角色

身份是 `(kind, language, role)` 三元组，**不允许只按语言名称合并**：

- 音频角色：`main`（完整解说，zh 330Hz / en 440Hz）、`secondary`（ja 554Hz、
  fr 659Hz）、`description`（zh-CN 描述性音频 220Hz，与 zh 主解说同语言不同角色）
- 字幕角色：`dialogue`（完整对白）、`forced`（强制字幕，仅歌词/画外音）
- `en-forced` 时间线 0–16s，用于验证轨道中途结束后的显式提示
- `fr` 的 3 号分片声明 `missing`，用于验证分片失败与声明式回退

组合规则在 `program.json -> combinationRules.disallowed` 按角色声明：
`description + dialogue` 禁止（描述音频已含场景解说），原因会原样显示；
`description + forced` 允许；字幕 `null`（关闭）与任何音频兼容。

## 界面怎样启动

```bash
npm install
npm run generate     # 生成媒体（见下方 ffmpeg 说明）
npm start            # http://localhost:8080 ，零依赖静态/Range 服务器
```

浏览器打开 `http://localhost:8080/`：

1. 左侧「音频轨」点击即**仅切换音频**，保持原有行为，字幕不动。
2. 「字幕轨」点击「关闭字幕」或某条字幕，会与当前选中音频组成一次组合请求；
   被禁止的组合在页面横幅显式拒绝，任何状态都不变。
3. 画面下方进度条可拖动，松手后由内核执行 seek：画面、当前选中声音、字幕都在
   新位置重建；字幕不会回到第一条 cue。
4. 状态卡区分「选中组合（请求）」与「有效组合（实际）」，并显示确认版本号；
   选中但未生效（不可用/回退）会明示，不会假定资源已加载。
5. 字幕浮层叠加在视频上；关闭字幕只清除文字，音频继续发声。

## 测试与运行说明

```bash
# 一次性准备 headless Chromium 的运行库（Debian 12 arm64，无 root）
bash tools/fetch-chromium-libs.sh
npx playwright install chromium

npm test                                  # 全部 24 例
npx playwright test tests/kernel.spec.mjs # 仅音频回归 9 例
npx playwright test tests/combinations.spec.mjs
```

`combinations.spec.mjs` 覆盖的验收点：

- 同语言不同角色（zh main vs zh description、zh dialogue vs zh forced）独立可选，
  并用分析器实测 220Hz/330Hz 确认真实发声身份
- 跨 4s 分片边界的 cue 持续显示、按自身 end 时间消失，画面时间码同步推进
- 字幕轨 16s 中途结束：选中保留、有效字幕清空、横幅明示、音频不停止
- 禁止组合返回 `accepted:false`、版本号不增加、状态不变、页面出现红色拒绝提示
- 连续快速切换 5 个组合后收敛到最后一个确认版本，不出现旧字幕配新音频
- 给字幕分片注入 2.5s 延迟，验证慢请求的陈旧字幕不会覆盖新选择
- 仅音频 `selectTrack` 行为不变；关闭字幕清空浮层且 330Hz 声音仍在
- 拖动进度条后画面时间码、音频 bufferOffset（中途加入）、字幕 cue 全部对齐
- 给 en 音频注入 1.5s 解码延迟，核验生效轨仍是 440Hz 且音画漂移中位数 < 80ms

### ffmpeg 平台说明

`ffmpeg-static` 在部分环境下发的是其他平台的二进制（本机为 macOS Mach-O），
此时用 Linux 静态构建并通过环境变量覆盖即可，仓库代码默认仍走 ffmpeg-static：

```bash
FFMPEG_PATH=/path/to/linux/ffmpeg npm run generate
```
