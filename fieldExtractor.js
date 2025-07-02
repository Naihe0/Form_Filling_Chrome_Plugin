const FieldExtractor = (function() {
    // Module-level state, initialized via init()
    let statusUI = null;
    let isStopped = () => false; // Function to check the stopped state
    let askLLM = null;
    let selectedModel = 'gpt-4.1';

    /**
     * Processes a single chunk of HTML using an LLM to extract form fields.
     * @param {string} html - The HTML chunk to process.
     * @param {number} chunkIndex - The index of the current chunk for logging.
     * @returns {Promise<Array|null>} A promise that resolves to an array of extracted field objects.
     */
    async function processHtmlChunkWithLLM(html, chunkIndex) {
        const prompt = 
        `
        你是一个HTML解析专家。严格分析以下网页问卷的HTML片段，
        并仅返回此片段中存在的所有问卷问题，选项等信息。输出一个纯JSON数组，
        其中每个对象代表一个问题。

        分块处理: 正在处理多个块中的第 ${chunkIndex} 块。

        每个字段对象必须包含:
        - 'question': 问题文本。
        - 'action': "click" 或 "fill"。
        - 'selector': 用来回答当前问题，能够用JavaScript代码发起事件进行点击或者填充的选择器数组。如果问题是选择题，返回包含所有选项对应选择器的数组。
        - 'options': 一个包含所有可用选项文本的数组。

        指南:
        1.  **严格性**: 只分析提供的HTML。不要猜测或包含HTML之外的字段。确保输出是纯粹的、格式正确的JSON数组，不包含任何解释性文本。

        HTML片段如下:
        \`\`\`
        html
${html}
        \`\`\`
        `;

        try {
            console.log(`[LLM模式] Chunk #${chunkIndex} HTML to be processed (first 500 chars):`, html.substring(0, 500) + '...');
            let rawResponse = await askLLM(prompt, selectedModel);
            console.log(`[LLM模式] Chunk #${chunkIndex} Raw LLM Response:`, rawResponse);

            let extractedFields = rawResponse;
            if (typeof extractedFields === 'object' && extractedFields !== null && !Array.isArray(extractedFields)) {
                const arrayKey = Object.keys(extractedFields).find(key => Array.isArray(extractedFields[key]));
                if (arrayKey) {
                    extractedFields = extractedFields[arrayKey];
                } else {
                    extractedFields = [extractedFields];
                }
            }
            
            if (!Array.isArray(extractedFields)) {
                console.warn(`[LLM模式] Chunk #${chunkIndex} 的 LLM 响应不是有效的数组，将返回空。`);
                return [];
            }
            
            console.log(`[LLM模式] Chunk #${chunkIndex} 解析后的字段:`, extractedFields);
            return extractedFields;
        } catch (e) {
            console.error(`[LLM模式] 处理 HTML 块 #${chunkIndex} 时发生严重错误:`, e);
            return [];
        }
    }

    /**
     * Chunks the body HTML and processes each chunk to extract all fields from the page.
     * @returns {Promise<Array>} A promise that resolves to an array of unique field objects.
     */
    async function extractFieldsWithLLM() {
        console.log("[LLM模式] 开始使用 LLM 提取字段...");
        const formElement = document.body;
        
        const formClone = formElement.cloneNode(true);
        formClone.querySelectorAll('script, style, noscript, svg, footer, nav').forEach(el => el.remove());

        const MAX_CHUNK_SIZE = 15000;
        const chunks = [];
        let currentChunkHtml = '';

        let parentContainer = formClone;
        if (formClone.children.length === 1 && formClone.children[0].children.length > 1) {
             parentContainer = formClone.children[0];
        }

        const elementsToChunk = Array.from(parentContainer.children);

        for (const element of elementsToChunk) {
            const elementHtml = element.outerHTML;
            if (!elementHtml) continue;

            if (currentChunkHtml.length + elementHtml.length > MAX_CHUNK_SIZE && currentChunkHtml.length > 0) {
                chunks.push(currentChunkHtml);
                currentChunkHtml = '';
            }
            currentChunkHtml += elementHtml + '\\n';
        }

        if (currentChunkHtml.length > 0) {
            chunks.push(currentChunkHtml);
        }

        console.log(`[LLM模式] HTML 被智能地分为 ${chunks.length} 个块进行处理。`);

        const allFields = [];
        for (const [index, chunk] of chunks.entries()) {
            if (isStopped()) {
                console.log("[LLM模式] 字段提取被用户中断。");
                return [];
            }
            // Use startTimer to show progress and the running timer
            statusUI.startTimer(`🔍 正在提取页面字段... (${index + 1}/${chunks.length})`);

            console.log(`[LLM模式] 正在处理块 ${index + 1}/${chunks.length}...`);
            const result = await processHtmlChunkWithLLM(chunk, index + 1);
            if (result && Array.isArray(result)) {
                const fieldsWithChunk = result.map(field => ({ ...field, htmlChunk: chunk }));
                allFields.push(...fieldsWithChunk);
            }
            await new Promise(r => setTimeout(r, 500)); // Rate limiting
        }

        console.log(`[LLM模式] 所有块处理完毕，去重前共 ${allFields.length} 个字段。`);

        const uniqueFields = [];
        const seenFields = new Set();
        for (const field of allFields) {
            if (field.selector) {
                const fieldKey = `${field.question}|${field.selector}`;
                if (!seenFields.has(fieldKey)) {
                    uniqueFields.push(field);
                    seenFields.add(fieldKey);
                }
            }
        }
        
        console.log(`[LLM模式] 总共提取到 ${uniqueFields.length} 个独立字段。`);
        return uniqueFields;
    }

    /**
     * Takes an array of fields and a user profile, and asks the LLM to add a 'value' key to each field.
     * @param {Array} fields - The array of field objects to be filled.
     * @param {string} profile - The user's profile data as a string.
     * @returns {Promise<Array>} A promise that resolves to the fields array with 'value' keys added where appropriate.
     */
    async function addValuesToFields(fields, profile) {
        const fieldsForPrompt = fields.map(({ htmlChunk, ...rest }, index) => ({
            ...rest,
            _id: index
        }));

        console.log("发送给LLM用于添加填充值的字段:", JSON.stringify(fieldsForPrompt, null, 2));
        const prompt = `
        你是一个高度智能的AI表单填充助手。你的任务是根据用户资料，为给定的JSON字段数组中的每个对象添加一个 'value' 键。

        --- 用户资料 ---
        ${profile}

        --- 表单字段 (JSON数组) ---
        ${JSON.stringify(fieldsForPrompt, null, 2)}

        --- 填充规则 ---
        1.  **分析**: 仔细分析每个字段对象的 'question', 'action', 和 'options'。
        2.  **填充 'value'**: 根据用户资料和问题，确定最匹配的填充值。
            *   对于 **"action": "fill"**，'value' 应该是一个包含 **字符串** 的数组。
            *   对于 **"action": "click"**，'value' 应该是一个包含 **字符串** 的数组，且必须是 'options' 数组中的一个值。
            *   如果根据用户资料找不到任何匹配的答案，请 **不要** 添加 'value' 键，并原样保留该对象。
        3.  **保留ID**: 你 **必须** 在返回的每个JSON对象中保留原始的 '_id' 字段。
        4.  **输出**: 你的输出必须是，也只能是一个JSON数组，其中包含所有被处理过的字段对象。不要添加任何解释性文字或将它包装在另一个JSON对象中。

        --- 输出 (修改后的JSON数组) ---
        `;
        
        try {
            console.log("[LLM模式] 添加填充值的提示:", prompt);
            let updatedFieldsFromLLM = await askLLM(prompt, selectedModel);
            console.log("LLM 返回的带填充值的字段:", updatedFieldsFromLLM);
            
            if (typeof updatedFieldsFromLLM === 'object' && updatedFieldsFromLLM !== null && !Array.isArray(updatedFieldsFromLLM)) {
                const arrayKey = Object.keys(updatedFieldsFromLLM).find(key => Array.isArray(updatedFieldsFromLLM[key]));
                if (arrayKey) {
                    updatedFieldsFromLLM = updatedFieldsFromLLM[arrayKey];
                } else {
                    updatedFieldsFromLLM = [updatedFieldsFromLLM];
                }
            }

            if (!Array.isArray(updatedFieldsFromLLM)) {
                console.error("LLM did not return a valid array after attempting to unwrap.", updatedFieldsFromLLM);
                return fields;
            }

            const updatedFieldsMap = new Map();
            updatedFieldsFromLLM.forEach(field => {
                if (field._id !== undefined) {
                    updatedFieldsMap.set(field._id, field);
                }
            });

            const finalFields = fields.map((originalField, index) => {
                const updatedField = updatedFieldsMap.get(index);
                if (updatedField) {
                    const { _id, ...restOfUpdatedField } = updatedField;
                    return {
                        ...originalField,
                        ...restOfUpdatedField
                    };
                }
                return originalField;
            });

            return finalFields;

        } catch (e) {
            console.error("添加填充值时出错:", e);
            return fields;
        }
    }

    // Public interface
    return {
        /**
         * Initializes the FieldExtractor module with necessary dependencies.
         * @param {Object} config - The configuration object.
         * @param {Object} config.statusUI - The UI status handler.
         * @param {Function} config.isStopped - A function that returns the current stopped state.
         * @param {Function} config.askLLM - The function to call for LLM requests.
         * @param {string} config.selectedModel - The model to use for LLM requests.
         */
        init: function(config) {
            statusUI = config.statusUI;
            isStopped = config.isStopped;
            askLLM = config.askLLM;
            selectedModel = config.selectedModel;
        },

        /**
         * The main entry point for extracting fields from the page.
         * @returns {Promise<Array>} A promise that resolves to an array of unique field objects.
         */
        extractFields: async function() {
            console.log("启动LLM字段提取模式...");
            return await extractFieldsWithLLM();
        },
        
        /**
         * The main entry point for adding values to extracted fields.
         * @param {Array} fields - The array of field objects.
         * @param {string} profile - The user's profile data.
         * @returns {Promise<Array>} A promise that resolves to the updated fields array.
         */
        addValuesToFields: addValuesToFields
    };
})();
