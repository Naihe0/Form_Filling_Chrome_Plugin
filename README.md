# 智能表单填充助手 (AI Form Filler)

这是一个基于大语言模型（LLM）的智能Chrome浏览器插件，旨在自动化填充网页表单的过程。它能够分析复杂的表单，并根据用户预先设定的个人画像信息，智能地完成填写和提交。

## ✨ 功能特性

- **AI驱动**：利用大型语言模型（如OpenAI的GPT系列）来理解表单字段的语义，而不是依赖固定的规则。
- **快捷问询 (Quick Query)**: 在任何页面的输入框中，快速连按三次 `·` 键，即可触发快捷问询。插件会结合当前输入框内容和您的用户画像，向LLM请求补全建议，并自动将结果填入，极大提升内容创作和填写的效率。
- **自然语言配置**：用户只需用自然语言描述自己的个人信息（用户画像），无需编写复杂的JSON或代码。
- **动态字段识别**：能够智能识别各种类型的输入字段，包括文本框、单选按钮、复选框、评分、NPS等。
- **智能纠错**：当第一次尝试填充失败时，插件会自动截取相关HTML片段，再次请求LLM进行分析，并尝试使用修正后的选择器进行填充。
- **歧义处理**：当一个选择器匹配到多个元素时，插件会根据字段描述文本（问题）与元素周边文本的关联性，智能选择最匹配的元素。
- **可视化操作反馈**：在页面上实时显示当前正在处理的字段，并以不同颜色的边框高亮显示填充状态（处理中、成功、失败）。
- **云端同步**：支持与 [mem0.ai](https://mem0.ai) 平台联动，实现用户画像的云端存储、拉取和同步，确保信息在多设备间的一致性。
- **无缝激活**: 插件核心脚本会在页面加载时自动注入。无论是自动填表还是快捷问询，功能开启后，在任何新打开的页面都会自动激活，无需重复操作。
- **灵活配置**：提供UI界面，方便用户随时填写和修改 mem0 相关参数（如 API Key, Agent ID 等），配置信息持久化保存。
- **模块化代码**：核心的字段处理逻辑被封装在 `fieldProcessor.js` 中，使得代码更易于维护和扩展。

## 🚀 工作流程

插件主要有两种工作模式：**自动填充** 和 **快捷问询**。

### 自动填充流程

1.  **用户配置**：
    - **本地模式**：用户在插件的“用户画像”视图中输入描述个人信息的文本。
    - **云端模式**：用户启用 mem0 同步，并在弹出的对话框中填写自己的 mem0 API Key 及相关参数（Agent ID, User ID 等）。
    - 用户在“开始填充”视图中输入自己的大模型 API Key（如 OpenAI）。
2.  **脚本注入**：当用户访问网页时，插件会自动将核心逻辑脚本 (`content.js` 等) 注入到当前页面。
3.  **启动填充**：用户在目标网页上点击插件的“开始填充”按钮。
4.  **获取画像**：如果启用了 mem0，插件会从 mem0.ai 云端拉取最新的用户画像；否则，使用本地保存的画像。
5.  **页面分析**：`content.js` 脚本接收到开始指令后，首先将页面的HTML进行分块和清洗（移除脚本、样式等无关元素），然后将HTML块和用户画像发送给LLM，请求其识别出所有需要填充的表单字段（包括问题、CSS选择器和动作）。
6.  **字段处理**：`content.js` 接收到LLM返回的字段列表后，会逐一调用 `fieldProcessor.js` 中的 `processSingleField` 方法进行处理。
7.  **执行与验证**：`fieldProcessor.js` 负责具体执行操作（如输入、点击），处理歧义，并在操作失败时启动LLM纠错流程。
8.  **完成**：所有字段处理完毕后，插件会显示完成状态。

### 快捷问询流程

1.  **用户配置**：用户在插件的“开始填充”视图中设置好用户画像和API Key。
2.  **功能开启**：用户在“开始填充”视图中，打开“快捷问询”功能的滑动开关。
3.  **自动监听**：插件的 `content.js` 脚本在页面加载时，会自动检测到“快捷问询”已开启，并开始监听用户的键盘输入。
4.  **触发问询**：用户在任意页面的文本框或文本域中，快速连续点击三次 `·` 键。
5.  **生成内容**：`content.js` 捕获到该操作后，会获取当前输入框的已有内容，结合用户画像，发送给LLM请求续写或生成内容。
6.  **自动填充**：LLM返回结果后，插件会自动将其追加到当前输入框中。

## 🛠️ 文件结构

- `manifest.json`: 插件的配置文件。现在通过 `content_scripts` 字段实现脚本的自动注入。
- `popup.html` / `popup.css` / `popup.js`: 插件弹出窗口的界面和交互逻辑，包括“快捷问询”的开关控制。
- `background.js`: 后台服务脚本，主要负责代理对大模型API的请求，以保护API Key不直接暴露在内容脚本中。
- `content.js`: 内容脚本，是插件在目标页面上运行的核心。它负责初始化和管理**自动填充**和**快捷问询**两大功能，并控制状态UI的显示。
- `fieldExtractor.js`: 字段提取器，负责与LLM通信，从页面HTML中分析和提取出需要填充的表单字段。
- `fieldProcessor.js`: 字段处理器，封装了所有与单个字段交互的复杂逻辑，包括元素定位、歧义处理、动作执行和LLM纠错。
- `icons/`: 存放插件所需的各种尺寸的图标。

## 🔧 安装与使用

### 安装步骤

1.  下载或克隆此代码仓库到本地。
2.  打开Chrome浏览器，地址栏输入 `chrome://extensions` 并回车。
3.  在页面右上角，打开“开发者模式”开关。
4.  点击“加载已解压的扩展程序”按钮，然后选择代码仓库所在的文件夹。
5.  **重要**：安装或更新后，请点击扩展程序卡片上的“刷新”按钮，以确保 `manifest.json` 的最新配置生效。

### 使用方法

#### 自动填充

1.  点击浏览器工具栏上的插件图标。
2.  在“ADD”标签页，你可以选择：
    - **本地填写**：直接在文本框中输入描述你个人信息的文本，然后点击保存。新增的画像会追加到历史记录中。
    - **云端同步**：打开“上传用户画像至 mem0”开关。在保存新画像时，如果 mem0 参数未配置，会自动弹窗提示你输入。输入的内容会上传到你的 mem0 账户。
3.  在“FILL”标签页：
    - 输入你的大模型 API Key（例如 OpenAI 的 Key）。
    - 打开“从 mem0 获取用户画像”开关，插件将使用云端的用户画像进行填充。如果参数缺失，点击“开始填充”时会弹窗提示。
4.  打开一个包含表单的网页。
5.  再次点击插件图标，然后点击“开始填充”按钮。
6.  观察插件自动完成表单填充的过程。如果需要，可以随时点击“停止填充”按钮来中断操作。
7.  如果在填充或上传过程中遇到 mem0 参数错误，状态栏下方会出现“修改 mem0 参数”按钮，方便你随时更正。

#### 快捷问询

1.  确保已在“ADD”和“FILL”标签页设置好你的用户画像和API Key。
2.  在“FILL”标签页，打开“快捷问询”的滑动开关。
3.  打开任意网页，在需要输入的文本框或文本域中，输入一些引导性文字。
4.  快速连续按三次 `·` 键。
5.  等待片刻，AI生成的内容就会自动填充到你的光标之后。

# Privacy Policy for AI Form Filler

**Last Updated: July 8, 2025**

This Privacy Policy describes how the "AI Form Filler" Chrome Extension (the "Extension") collects, uses, and shares information.

---

## English Version

### 1. Introduction
Welcome to AI Form Filler. We are committed to protecting your privacy. This policy outlines our practices concerning the information we handle to provide our form-filling services. By using our Extension, you agree to the collection and use of information in accordance with this policy.

### 2. Information We Collect
To provide its core functionality, the Extension needs to handle several types of data:

*   **User-Provided Information**:
    *   **User Profile**: You provide descriptive text about yourself ("User Profile") which is used as context for the AI to fill forms accurately.
    *   **API Keys**: You provide an API key for a third-party Large Language Model (LLM) provider (e.g., OpenAI, ZhipuAI, etc.). This key is required to make API calls to the service.
    *   **mem0 Credentials (Optional)**: If you choose to use the mem0.ai integration for long-term memory, you will provide credentials for the mem0.ai service.

*   **Web Page Content**:
    *   When you activate the Extension on a web page, it reads the labels and structure of the form fields on that page to understand what information is required.

### 3. How We Use Your Information
Your data is used exclusively to enable the features of the Extension:

*   **To Fill Forms**: The primary use of your information is to fill out web forms. The Extension sends your User Profile and the web page's form-field context to the LLM provider you configured. The provider's AI model then generates the appropriate text to fill in the fields.
*   **To Provide Long-Term Memory (Optional)**: If you enable the mem0.ai integration, your User Profile data is sent to your mem0.ai account to create a persistent memory, allowing the AI to provide more consistent and context-aware responses over time.

### 4. How We Share Your Information
Your data is only shared with the services you explicitly configure and consent to use. We do not sell or share your data with any other third parties.

*   **Large Language Model (LLM) Providers**: To fill a form, the Extension sends your User Profile and the form's context to the LLM provider associated with the API key you provided. The privacy of this data is subject to the privacy policy of that specific provider (e.g., OpenAI, etc.).
*   **mem0.ai (Optional)**: If you enable this feature, your User Profile data will be sent to mem0.ai, governed by their privacy policy.

### 5. Data Storage and Security
We take your privacy seriously and handle your data with care.

*   **Local and Synchronized Storage**: Your User Profile, API keys, and settings are stored using Chrome's built-in storage APIs (`chrome.storage.local` and `chrome.storage.sync`).
    *   `chrome.storage.local` stores data on your local machine.
    *   `chrome.storage.sync` syncs your data across your devices where you are logged into your Chrome profile. This data is managed by Google and subject to their privacy policy.
*   **Data Transmission**: All data sent to third-party services (LLM providers, mem0.ai) is transmitted securely over HTTPS.

### 6. Your Choices and Control
You have full control over your data:

*   You can view, edit, or delete your User Profile at any time within the Extension's popup.
*   You can change or remove your API keys at any time.
*   You can enable or disable the mem0.ai integration at any time. Disabling it will stop any further data from being sent to mem0.ai.

### 7. Changes to This Privacy Policy
We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy in this section. You are advised to review this Privacy Policy periodically for any changes.

### 8. Contact Us
If you have any questions about this Privacy Policy, please open an issue on our GitHub repository.

---

## 中文版本 (Chinese Version)

### 1. 引言
欢迎使用“AI智能填表助手”。我们致力于保护您的隐私。本政策概述了我们为提供表单填充服务而处理信息的相关做法。使用本扩展程序，即表示您同意我们根据本政策收集和使用信息。

### 2. 我们收集的信息
为了提供核心功能，本扩展程序需要处理以下几类数据：

*   **用户提供的信息**:
    *   **用户画像**: 您提供关于您自己的描述性文本（“用户画像”），AI 将其用作上下文以准确填写表单。
    *   **API密钥**: 您提供一个第三方大型语言模型（LLM）服务商（如 OpenAI, ZhipuAI 等）的API密钥。该密钥是调用其服务的必需品。
    *   **mem0凭据 (可选)**: 如果您选择使用 mem0.ai 集成以实现长期记忆功能，您需要提供 mem0.ai 服务的凭据。

*   **网页内容**:
    *   当您在某个网页上激活本扩展时，它会读取该页面上表单字段的标签和结构，以理解需要填写哪些信息。

### 3. 我们如何使用您的信息
您的数据仅用于实现本扩展程序的功能：

*   **用于填写表单**: 您的信息最主要的用途是填写网页表单。本扩展会将您的用户画像和网页的表单上下文发送给您配置的LLM服务商。该服务商的AI模型会生成相应的文本来填充字段。
*   **用于提供长期记忆 (可选)**: 如果您启用 mem0.ai 集成，您的用户画像数据将被发送到您的 mem0.ai 账户以创建持久化记忆，从而让AI能够提供更连贯、更具上下文感知能力的回答。

### 4. 我们如何共享您的信息
您的数据仅与您明确配置并同意使用的服务共享。我们不会将您的数据出售或与任何其他第三方共享。

*   **大型语言模型 (LLM) 服务商**: 为了填写表单，本扩展会将您的用户画像和表单上下文发送至您提供的API密钥所对应的LLM服务商。该数据的隐私受相应服务商（如 OpenAI 等）的隐私政策约束。
*   **mem0.ai (可选)**: 如果您启用此功能，您的用户画像数据将被发送至 mem0.ai，并受其隐私政策的约束。

### 5. 数据存储与安全
我们非常重视您的隐私，并谨慎处理您的数据。

*   **本地存储与同步存储**: 您的用户画像、API密钥和设置使用Chrome内置的存储API（`chrome.storage.local` 和 `chrome.storage.sync`）进行存储。
    *   `chrome.storage.local` 将数据存储在您的本地计算机上。
    *   `chrome.storage.sync` 会在您登录了Chrome账户的所有设备间同步您的数据。该数据由Google管理，并受其隐私政策的约束。
*   **数据传输**: 所有发送到第三方服务（LLM服务商, mem0.ai）的数据都通过HTTPS安全传输。

### 6. 您的选择与控制权
您对自己的数据拥有完全的控制权：

*   您可以随时在扩展程序的弹出窗口中查看、编辑或删除您的用户画像。
*   您可以随时更改或移除您的API密钥。
*   您可以随时启用或禁用 mem0.ai 集成。禁用后，将不会再有数据发送到 mem0.ai。

### 7. 隐私政策的变更
我们可能会不时更新我们的隐私政策。如有任何变更，我们会通过在此处发布新的隐私政策来通知您。建议您定期查看本隐私政策以了解任何变更。

### 8. 联系我们
如果您对本隐私政策有任何疑问，请在我们的GitHub仓库中提交一个 issue。
