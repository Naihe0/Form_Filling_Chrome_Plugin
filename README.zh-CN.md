# AI 智能填表助手

一个 Chrome 扩展：根据你用自然语言写的个人画像，用大模型（使用你自己的 API 密钥）填写网页表单。

[English](README.md)

只需介绍一次自己。在任意表单上点击**开始填充**，检查填写结果，然后由你自己提交。它能处理原生控件、自定义下拉框、级联选择器、日历、问卷组件、内嵌框架，以及随作答才出现的字段，并[在真实的 Ant Design、Material UI 和 Element Plus 表单上做过评测](docs/TESTING.md#latest-results)。

## 为什么可以信任它

- **它会核对自己的工作。** 每个值都会从页面读回验证。报告会区分哪些已被证实、哪些需要你核对。
- **它绝不提交。** 也绝不碰密码、支付信息、验证码、人机验证、同意条款和文件上传。这些规则由代码强制执行，页面文字无法说服模型绕过。
- **它发送的内容很少。** 模型只看到字段标签和选项，看不到页面 HTML、隐藏输入框或其他字段的内容。[具体发送了什么](PRIVACY.md#隐私政策)。
- **它把机密留在页面之外。** 密钥和画像保存在扩展的受信任环境中，网页上运行的脚本无法读取。
- **它不会乱猜。** 如果画像中没有答案，该字段会留空，并在报告中说明。

## 安装

需要 Node 22.18 或更高版本，以及 Chrome 121 或更高版本。

```bash
git clone https://github.com/Naihe0/Form_Filling_Chrome_Plugin.git
```

```bash
cd Form_Filling_Chrome_Plugin
```

```bash
npm install
```

```bash
npm run build
```

然后打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**，选择 `dist` 文件夹。

> **从 v2 升级？** 现在要加载的是 `dist/`，而不是仓库根目录，所以需要移除旧的已解压扩展。已解压扩展的身份取决于所在文件夹，新扩展的设置是空的：移除旧扩展之前，请先把画像和密钥复制出来。通过 Chrome 网上应用店更新时身份不变，所有设置会自动迁移。

## 使用

1. **画像页：** 用任意语言介绍自己并保存，例如姓名、联系方式、教育背景、工作经历、偏好。请勿填写密码或银行卡号。
2. **填充页：** 选择服务商并输入 API 密钥。模型 ID 留空则使用默认模型。
3. 在表单页面点击**开始填充**。
4. 检查页面。面板会列出需要你处理的项目，点击可跳转到对应字段。
5. 由你自己提交表单。

**覆盖已有内容**：同时改写已有内容的字段，默认关闭。

**快捷问询**：开启后，在任意文本框中以 ` ``` ` 或 `···` 结尾，模型会根据画像续写内容。

## 服务商

| 服务商 | 默认模型 | 实测 |
|---|---|---|
| Gemini | `gemini-flash-latest` | 是，[已在全部测试页面上评分](docs/TESTING.md#latest-results) |
| OpenAI | `gpt-5.2` | 否 |
| OpenRouter | `openai/gpt-5.2` | 否 |
| Qwen | `qwen3.5-plus` | 否 |

你可以填写服务商提供的任意模型 ID。四家都使用相同的 OpenAI 兼容协议，扩展会自动去掉模型不接受的请求参数。未实测的服务商理论上可用，但目前只经过模拟响应的测试。

## 局限

- 只填写当前页面，从不点击“下一步”。多步表单请在每一步重新运行。
- 无法访问封闭的 Shadow Root，也无法处理绘制在 canvas 上的表单。
- 无法操作忽略脚本事件的组件（检查 `isTrusted` 的组件），报告会标出这类字段。
- 无法识别没有文字的选项，例如纯图标的星级评分。
- 提示注入只能缓解，无法杜绝。恶意页面可以展示一个询问手机号的字段，模型会照常填写。在你提交之前没有任何内容离开页面，所以请务必检查。[详情](docs/HARNESS.md#prompt-injection)。
- AI 的回答可能出错，提交前请务必检查。

## 开发

```bash
npm run watch
```

```bash
npm run check
```

`npm run check` 会运行类型检查、单元测试和真实浏览器测试。浏览器测试需要先安装一次 Chromium：

```bash
npx playwright install chromium
```

用真实模型为 harness 评分：

```bash
GEMINI_API_KEY=your-key npm run eval
```

```bash
GEMINI_API_KEY=your-key npm run eval:frameworks
```

请在自己的终端中使用密钥运行，切勿把密钥提交到仓库。PowerShell 写法等更多内容见[测试文档](docs/TESTING.md)。

## 文档

以下技术文档为英文：

- [Harness 设计](docs/HARNESS.md)：如何让模型保持诚实，以及为什么这样做。
- [架构](docs/ARCHITECTURE.md)：进程、信任边界、数据流。
- [测试](docs/TESTING.md)：测试分层、评测套件、最新结果。
- [隐私政策](PRIVACY.md)
- [更新日志](CHANGELOG.md)
