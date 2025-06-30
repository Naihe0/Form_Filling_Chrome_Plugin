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
    } else {
        API_URL = 'https://api.openai.com/v1/chat/completions';
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

    // Clean up potential markdown code blocks
    if (content.startsWith("```")) {
        return content.match(/\{.*\}|\[.*\]/s)[0];
    }
    return content;
}