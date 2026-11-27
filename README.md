# Robot Data Viewer

双击 `index.html` 打开离线分析工作台。浏览器读取所选录制，页面无需服务或网络。默认使用中文和浅色主题，可在页头切换。

## 工作流

1. 导入单个 TAR、拖入多个 TAR，或打开已解压的会话目录。有帧清单的录制默认进入「联动分析」。常规回放依然支持通道筛选、原始画幅、双目合并与拆分、倍速和全屏。
2. 用会话质检条查看自动评级、同步跨度、补帧、序列跳变、Pose 覆盖率及外设断流。「阈值设置」会重算已经导入的帧清单。人工标签和备注保存在当前浏览器。
3. 拖动联动视图的分隔条调整相机与图表高度。拖动图表定位视频，使用 Shift + 拖动框选所有图表，双击重置缩放。可选悬停预览。数据分析页含四张帧清单图，也保留原有相机时间戳、传感器 CSV 曲线与通道质量导出。
4. 按 **D** 查看当前帧的同步源、各相机序列、外设与 Pose。可展开 Raw JSON、复制诊断或导出可见相机拼接 PNG。四轨时间轴从上到下说明同步跨度、相机异常、左右夹爪按键和传感器/Pose 健康。
5. 在触觉工具栏切换原图、基准差分或 Turbo 伪彩。默认取首帧作基准，可更换基准并调整增益。相机旋转与镜像按通道名保留；双击画面可聚焦。声音按钮启用主相机视频内的音轨。
6. 「批量质检总览」可扫描目录内各会话的帧清单。打开包含多个帧清单的目录也会进入总览。批量扫描只读清单，点击结果才打开相机。可按分级和人工标签筛选、按列排序，以及导出质检 CSV 或筛选后的会话 JSON。

Pose 场景按需加载。缺失时显示左右侧覆盖率和可定位的断流区间。IMU 姿态使用加速度校正倾角，偏航为相对估计。视频的 HEVC 解码和 3D 的 WebGL 2 渲染取决于浏览器和设备。

## 录制格式

```text
session/
  metadata.json
  meta/global_frame_manifest.jsonl
  observation.image.third_view/
    video.mp4
    timestamps.csv
    timestamps_raw.csv
  observation.image.left_wrist_view/
    video.mp4
    timestamps.csv
  observation.state.tracker/
    data.csv
```

帧清单也可位于会话根目录，支持导出中的相机别名和自定义相机键。清单里的 `nominal_pts_us` 用于定位会话帧，逐帧排障优先使用各路相机的编码 PTS。无清单的会话仍可使用视频回放与 CSV 分析，步进按参考相机帧率估算。

默认同步警告与失败阈值为 1 ms 与 10 ms，夹爪与 IMU 间隔阈值为 15 ms 与 25 ms，含补帧的帧占比阈值为 1%。显式的 `within_10ms: false`、无效相机组和设备记录的断流会触发失败。仅有序列偏离、Pose 缺失或硬触发未验证等问题时显示警告。人工标签和自动评级分别保存。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| Space | 播放或暂停 |
| ← / → | 上一帧或下一帧 |
| Shift + ← / → | 后退或前进十帧 |
| , / . | 上一帧或下一帧 |
| [ / ] | 上一个或下一个符合筛选的异常帧 |
| I / O / L | 设置 A / B，开关循环 |
| D | 开关单帧检视器 |
| 1 / 2 / 3 | 标记合格 / 待复核 / 废弃 |
| F | 全屏 |
| Esc / ? | 关闭弹窗 / 显示快捷键 |

## 开发与验证

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

`npm run build` 生成并检查本地供应商资源。仓库包含生成后的 `vendor/`，直接打开页面时可使用。清单解析和统计在独立 Worker 内完成，列式数据与原始帧字节索引通过 Transferable 交给当前会话。播放位置由 Frame Clock Bus 直接更新到画面、时间轴、图表游标和空间视窗。

第三方可视化依赖为 [uPlot](https://github.com/leeoniya/uPlot) 和 [Three.js](https://threejs.org/)。触觉伪彩使用 Google 的 [Turbo 色图多项式](https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7)。许可证见 `vendor/`。
