---
name: bandi-avatar
description: 班底平台的头像生成手册 —— 给数字员工/专家生成或修改头像的固定工序。被问到"生成头像/换个头像/画个头像/头像不好看"时读它。含风格锁定的 prompt 模板、本机生图通道、裁剪避水印、落位绑定全流程。
---

# 班底 · 头像生成手册

这份手册让你能独立完成"给某个人生成一张头像"的完整流程。**工序是固定的，不要即兴发挥**——每一步都踩过坑，跳步的代价都是返工。

## 零、开工前先确认通道

生图走本机服务端的 AI 通道（端口见首轮注入给你的「机器现状」，一般是 8787）：

```bash
curl -s --noproxy '*' http://127.0.0.1:<端口>/api/ai/image-config
```

- 回 `configured: true` → 通道可用，继续。
- 回 `configured: false` → 生图服务没配（设置页「生图服务」卡片没填），**停下来告诉用户**："先到 设置 → 生图服务 填好地址和 Key，我再帮你生成。"不要硬试。

> `--noproxy '*'` 必带：开发机常有全局代理，回环请求走了代理会拿到 502，那不是服务挂了。

## 一、写 prompt（风格锁定，别自创）

**先读风格规范拿色板和完整模板**（这个文件在平台仓库里，任何员工都能读）：

```
<repoRoot>/docs/头像生成规范.md
```

`repoRoot` 从 `curl -s --noproxy '*' http://127.0.0.1:<端口>/api/state` 里拿。下面是两条模板的骨架：

**新建头像（文生图）**——厚涂软阴影卡通风，中景半身，头约占画面一半：

```
Flat painterly soft-shaded cartoon avatar portrait of <角色：性别/发型/眼镜/衣着/手持物>.
Medium shot showing head, shoulders and upper chest only; the head takes up roughly
half of the frame height. Character horizontally centered with comfortable empty
space above the hair. Solid muted <底色> background with subtle paper texture and a
soft vignette. Simple shapes, clean edges, warm friendly expression.
No text, no watermark, no border, no frame.
```

**修改已有头像（图生图）**——必须带原图，只指定要改的点，其余原样保留：

```
Keep this character and art style EXACTLY the same — same painterly soft-shaded
cartoon style, same face, hair, glasses, clothing, props, same muted textured
background. <要改的一两件事，如：remove the black rectangle above her head>.
No text, no watermark, no border.
```

底色从规范里的色板选一个**没被现有头像占用**的（低饱和、偏灰调）。改已有头像**一律走图生图**：从零生成的画风（扁平 vs 厚涂）和长相都不可控，这条是血泪教训。

## 二、生成

```bash
# 文生图
curl -s --noproxy '*' -X POST http://127.0.0.1:<端口>/api/ai/image \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"<上面写好的完整 prompt>","size":"1024x1024"}'

# 图生图（改已有头像）：多带一个 image 字段 = 原图绝对路径
curl -s --noproxy '*' -X POST http://127.0.0.1:<端口>/api/ai/image \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"<图生图模板>","size":"1024x1024","image":"<原图绝对路径>"}'
```

成功回 `{"file":"<生成图的绝对路径>","bytes":...,"model":...}`，`file` 就是 1024 方图的落盘位置（数据目录 `generated/` 下）。失败回 `{"error":"...","code":"E26xx"}`——`E2601` 是没配服务，其余照 error 文案向用户转述。

尺寸**固定 1024x1024 方图**，不要竖版（竖版裁出来人物比例不可控，全是大头照）。

## 三、裁剪（避水印 + 居中，一条命令）

生成图右下角贴着「AI生成」水印。裁剪脚本会自动水平居中、底边留 68px 安全带把水印裁掉：

```bash
node <repoRoot>/tools/avatar-process.mjs <生成的1024.png> <输出256.png>
```

- 人物略偏左/偏右时加第三个参数（正数=窗口左移）：`node ... a.png b.png -11` 表示窗口左移 11px。
- 头顶被裁没留白（内容贴顶）时用 `tools/avatar-nudge.mjs <入> <出> <下移px>` 整体下移补留白。

## 四、落位与绑定

1. 成品（256 方图）拷进平台仓库的头像目录，文件名用**小写字母数字连字符**（库字段校验只认 `[A-Za-z0-9._-]`）：

   ```bash
   cp <输出256.png> <repoRoot>/apps/web/avatars/<avatar-name>.png
   ```

2. 绑到人头上（`personas.avatar` 存文件名）：

   ```bash
   curl -s --noproxy '*' -X PUT http://127.0.0.1:<端口>/api/personas/<personaId> \
     -H 'Content-Type: application/json' \
     -d '{"avatar":"<avatar-name>.png"}'
   ```

3. 告诉用户刷新页面（前端静态文件，刷新即生效，不用重启服务）。

给**专家库的雇佣员工**换头像时直接覆盖它引用的文件即可（`personas.avatar` 同样是文件名），但身份信息（名字/岗位）改不了——那是专家包锁定的。

## 五、交货前过一遍这张清单

- [ ] 头顶有留白（不贴边），人物水平居中（左右留空大致对称）
- [ ] 无「AI生成」水印残留（右下角是高发区）
- [ ] 无黑色杆状/矩形等生成瑕疵
- [ ] 画风与现有头像一致（厚涂软阴影，不是扁平矢量）
- [ ] 底色和现有头像不撞色
- [ ] 文件名合法（字母数字连字符），绑定后让用户刷新确认

**别做这些**（每条都真踩过）：
- 不要在 prompt 里要求"底部加黑底避水印"——水印是生成后叠印的，黑底挡不住还毁构图；
- 不要用品牌印去盖水印——头像在 UI 里是圆形小图，盖印比水印更丑；
- 不要生成竖版再裁——人物比例不可控；
- 不要从零重画已有角色——必须原图做图生图；
- 不要跳过裁剪直接用 1024 原图——水印还在。
