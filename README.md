# SillyTavern 双语台词提取与 MiniMax TTS 语音扩展插件

本插件专为 **SillyTavern（傻酒馆）** 开发，能够自动或手动精准提取 AI 角色回复中的【英文台词】与【中文翻译】，过滤掉所有旁白描写与动作心理活动，并顺序调用 MiniMax TTS API 进行连贯的语音合成与排队自动播放。

---

## ✨ 核心特性

1. **台词双提取模式切换**：
   - **【模式 A：AI 智能提取（默认）】**：基于廉价大模型（如 DeepSeek-V3、GPT-4o-mini、SiliconFlow 等 OpenAI 兼容接口），利用专业 Prompt 过滤 `*He smiled...*` 等一切旁白动作，只提取真实台词，返回规整 JSON 结构。
   - **【模式 B：正则纯提取（备用/省流模式）】**：零 Token 消耗，使用高效正则表达式自动提取引号台词与紧随括号中的中文翻译（如 `"Hello." (你好。)`）。
   - **自动兜底保障**：开启后若 AI 接口网络超时或格式错误，自动降级为正则提取，绝不卡死。

2. **MiniMax 顺序语音排队系统**：
   - 支持 MiniMax T2A v2 接口（支持 `speech-01-turbo`、`speech-01-hd`、`speech-02` 等模型）。
   - 包含多句台词严格队列管理（上一句播完后等待指定毫秒，自动触发下一句）。
   - 可配置朗读目标：仅朗读英文原音、仅朗读中文、或英中双语连读。

3. **原生酒馆 UI 深度集成**：
   - **角色楼层右上角按钮**：每轮角色消息卡片右上角均有 `[🔊 朗读台词]` 专属按钮，点击即刻提取该楼并播放。
   - **酒馆底部快捷栏**：在输入框上方工具栏常驻 `[🎙️ TTS]` 快捷图标，一键呼出插件配置。
   - **右侧抽屉扩展面板**：无缝内嵌至酒馆设置抽屉，所有 API Key、发音人 Voice ID、语速及提示词均自动保存 (`saveSettingsDebounced`)。
   - **底部浮动双语字幕条**：播放时实时展示角色名、队列进度（如 1/3）、当前英文句子与中文翻译，支持上一句、暂停、下一句与停止。

---

## 📦 安装方法

### 方式一：一键下载解压（最简便）
### 方式一：通过 GitHub URL 直接在酒馆内安装（最推荐，支持在线一键更新）
1. 在 GitHub 上新建一个 **公开仓库 (Public Repository)**，例如命名为 `st-bilingual-minimax-tts`。
2. 将本插件解压后的所有文件（`manifest.json`, `index.js`, `settings.html`, `style.css`, `README.md`）**直接上传到 GitHub 仓库根目录下**。
   > ⚠️ **重要避坑提示**：文件必须直接放在仓库根目录，**千万不要在仓库里再包一层同名文件夹**！确保打开 GitHub 仓库首页就能直接看到 `manifest.json`。
3. 打开 SillyTavern 酒馆，依次点击：
   * 右侧面板 -> **扩展 (Extensions)** -> **安装扩展 (Install Extension)** -> **输入扩展程序的 Git URL 以安装**。
4. 粘贴你的 GitHub 仓库地址，例如：
   ```text
   https://github.com/你的用户名/st-bilingual-minimax-tts
   ```
5. 点击 **【为所有用户安装】** 或 **【仅为我安装】**，酒馆会自动完成 git clone 并挂载插件，刷新网页即可使用！

### 方式二：手动下载 ZIP 解压安装
1. 点击本工作台右上角 **【下载插件 ZIP】**。
2. 解压并将文件夹放入酒馆第三方扩展目录：
   ```bash
   SillyTavern/public/scripts/extensions/third-party/sillytavern-bilingual-minimax-tts/
   ```
3. 重启或刷新 SillyTavern 网页。

---

## ⚙️ 配置说明

在酒馆右侧抽屉面板的 **扩展设置 (Extensions)** 中找到 **“🎙️ 双语台词提取与 MiniMax TTS 朗读”**：

### 1. MiniMax 凭证配置
- **MiniMax API Key**: 在 [MiniMax 开放平台](https://platform.minimaxi.com/) 注册并创建 API Key。
- **MiniMax Group ID**: 开放平台右上角账户信息中的 `GroupId`（一串数字）。
- **Voice ID**: 可从下拉菜单预设中挑选，例如：
  - `male-qn-qingse` (青年男声)
  - `female-shaonv` (元气少女)
  - `female-yujie` (成熟御姐)
  - `presenter_male` (磁性播音)
  - `audiobook_male_2` (沉稳大叔)

### 2. AI 提取模型配置 (模式 A)
- **Base URL**: 如 `https://api.siliconflow.cn/v1` 或 `https://api.deepseek.com/v1` 或 `https://api.openai.com/v1`。
- **API Key**: 对应的 API 密钥。
- **Model**: `deepseek-ai/DeepSeek-V3` / `gpt-4o-mini` / `Qwen/Qwen2.5-7B-Instruct` 等超廉价模型。

---

## 🎮 使用流程
1. 在角色卡提示词中约定双语回复风格，例如：
   ```text
   输出规范：请在角色对白中使用英文，并在紧随其后的括号中附带中文翻译，例如："Good to see you." (很高兴见到你。) 旁白使用正常中文描写。
   ```
2. 当收到角色新回复时：
   - 若开启了【自动播放】，插件会自动提取并开始朗读。
   - 若未开启自动播放，点击该条回复右上角的 **【🔊 朗读台词】** 按钮。
3. 界面底部会升起双语字幕卡片，伴随角色原声依次朗读！


## v1.0.3 更新

- 正则提取同时兼容中文翻译括号位于引号内部或外部的格式。
- 新增“只朗读指定角色”筛选框，支持完整姓名和部分姓名；留空则朗读全部角色。
- AI 提取与正则提取结果都会经过同一角色筛选，手动朗读和自动播放均生效。


## v1.0.4 更新
- 每条角色消息增加右上角紧凑扬声器图标，不再显示占行的大按钮。
- 新增“保存全部配置”按钮，并保留输入时自动保存。
- 同一楼层处理期间防重复触发；成功提取后缓存台词，避免重复调用提取 API；相同音色/模型/文本缓存合成音频。
- 增加运行诊断记录，显示 API、解析、提取与播放失败原因。
