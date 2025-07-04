// Listens for messages from content scripts or popup to call the OpenAI API
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'llm-request') {
        const { prompt, apiKey, model } = request.payload;
        
        callOpenAI(prompt, apiKey, model)
            .then(response => {
                sendResponse({ success: true, data: response });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        
        return true; // Indicates that the response is sent asynchronously
    }
});

async function callOpenAI(prompt, apiKey, model) {
    let API_URL;
    let apiName = 'OpenAI'; // Default to OpenAI
    // Determine API URL based on the model selected
    if (model.startsWith('deepseek')) {
        API_URL = 'https://api.deepseek.com/v1/chat/completions';
        apiName = 'DeepSeek';
    } else if (model.startsWith('qwen')) {
        API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        apiName = 'Qwen';
    } else if (model.startsWith('gemini')) {
        API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        apiName = 'Gemini';
    } else if (model.startsWith('glm')) {
        API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
        apiName = 'GLM';
    } else {
        API_URL = 'https://api.openai.com/v1/chat/completions';
    }

    // --- Token usage tracking ---
    if (!globalThis._llmTokenStats) {
        globalThis._llmTokenStats = { input: 0, output: 0 };
    }

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            ...(prompt.includes("JSON") && { response_format: { "type": "json_object" } })
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`${apiName} API Error: ${response.status} ${response.statusText} - ${errorData.error.message}`);
    }

    const data = await response.json();
    console.log(`${apiName} API Response Data:`, JSON.stringify(data, null, 2));
    const content = data.choices[0]?.message?.content || "";

    // --- Token usage logging ---
    let inputTokens = 0, outputTokens = 0;
    if (data.usage) {
        inputTokens = data.usage.prompt_tokens || 0;
        outputTokens = data.usage.completion_tokens || 0;
        globalThis._llmTokenStats.input += inputTokens;
        globalThis._llmTokenStats.output += outputTokens;
        console.log(`[Token统计] ${apiName} 本次 Input: ${inputTokens}, Output: ${outputTokens}`);
        console.log(`[Token统计] ${apiName} 累计 Input: ${globalThis._llmTokenStats.input}, Output: ${globalThis._llmTokenStats.output}`);
    } else {
        console.warn(`[Token统计] ${apiName} 未返回 usage 字段，无法统计token。`);
    }

    // Clean up potential markdown code blocks
    if (content.startsWith("```")) {
        return content.match(/\{.*\}|\[.*\]/s)[0];
    }
    return content;
}