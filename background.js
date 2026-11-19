// =========================================================================
// fck-coursera background.js - AI Quiz Solver Service Worker (Gemini + OpenRouter)
// =========================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchAIExplanation") {
    handleAIRequest(request.text, request.options)
      .then((data) => sendResponse({ 
        result: data.result, 
        provider: data.provider, 
        model: data.model 
      }))
      .catch((error) => {
        console.error("[AI Service Worker Error]:", error);
        sendResponse({ 
          error: error.message || "Failed to fetch from AI.",
          status: error.status || 500,
          provider: error.provider || "ai"
        });
      });
    return true; // Asynchronous response
  }

  if (request.action === "navigateTo") {
    if (sender && sender.tab && sender.tab.id && request.url) {
      chrome.tabs.update(sender.tab.id, { url: request.url }, () => {
        sendResponse({ status: "navigating" });
      });
      return true;
    }
  }
});

// Helper: Sleep delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry function with exponential backoff and jitter for 429 / transient 5xx errors
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1500) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || (err.message && err.message.includes("429"));
      const isServerError = (err.status >= 500 && err.status < 600) || (err.message && /50[0234]/.test(err.message));
      const isNetwork = err.name === "TypeError" || (err.message && err.message.includes("fetch"));

      // Do NOT retry 401 (invalid key) or 402 (payment required)
      if (err.status === 401 || err.status === 402) {
        throw err;
      }

      if ((isRateLimit || isServerError || isNetwork) && attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 800, 15000);
        console.warn(`[AI Request] Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms due to: ${err.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Master dispatcher for AI requests
async function handleAIRequest(questionsArray, options = {}) {
  const storageData = await chrome.storage.local.get([
    "aiProvider",
    "userApiKey",
    "openRouterApiKey",
    "openRouterModel"
  ]);

  const provider = (storageData.aiProvider || "gemini").toLowerCase();

  if (provider === "openrouter") {
    return await handleOpenRouterRequest(questionsArray, storageData);
  } else {
    return await handleGeminiRequest(questionsArray, storageData);
  }
}

// Common System Prompt engineered for strict JSON parsing
function buildPrompt(questionsArray) {
  const questionsJsonString = JSON.stringify(questionsArray, null, 2);

  return `You are an expert academic tutor and exam assistant. I am providing you with a JSON array of quiz or assessment questions from an academic course.
Your task is to determine the correct answer(s) for each question with maximum precision, accuracy, and adherence to the course context.

INPUT QUESTIONS:
${questionsJsonString}

OUTPUT RULES (STRICTLY ENFORCED):
1. You must respond ONLY with a valid JSON array. Do not include markdown codeblocks (no \`\`\`json), no introductory text, and no conversational explanations.
2. The output must be an array of objects.
3. Each object must have exactly two keys: "questionNumber" (integer matching input) and "correctOptions" (array of strings).
4. For "single_answer" and "multiple_answer":
   - "correctOptions" MUST contain exact verbatim strings from the provided question's "options" array.
   - For multiple choice questions that permit multiple correct choices, include ALL correct options in the array.
5. For "text_input":
   - Provide a concise, highly accurate, direct numerical or textual answer as a single string inside "correctOptions".
6. For "essay" or rich-text questions:
   - Provide a clear, comprehensive, and well-structured answer (3-5 sentences fulfilling the prompt requirements) as a single string inside "correctOptions".

OUTPUT FORMAT EXAMPLE:
[
  {
    "questionNumber": 1,
    "correctOptions": ["Exact text of correct option"]
  },
  {
    "questionNumber": 2,
    "correctOptions": ["First correct choice", "Second correct choice"]
  }
]`;
}

// Helper: Normalize raw AI text into parsed array
function parseAIResponseJSON(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Empty response received from AI provider");
  }

  const cleanedText = rawText
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch (parseErr) {
    const arrayMatch = cleanedText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch (e) { }
    }
    throw new Error("AI returned malformed JSON output: " + cleanedText.slice(0, 150));
  }
}

// --- OpenRouter API Handler ---
async function handleOpenRouterRequest(questionsArray, storageData) {
  const API_KEY = storageData.openRouterApiKey ? storageData.openRouterApiKey.trim() : "";
  const model = (storageData.openRouterModel && storageData.openRouterModel.trim()) || "openrouter/auto";

  if (!API_KEY) {
    const err = new Error("Missing OpenRouter API key. Please configure your key at https://openrouter.ai/keys and save it in extension settings.");
    err.status = 401;
    err.provider = "openrouter";
    throw err;
  }

  const prompt = buildPrompt(questionsArray);

  const executeCall = async () => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/dietcokezerosugar/fck-coursera",
        "X-OpenRouter-Title": "Coursera Speedrunner"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are an expert exam solver. You respond with valid JSON arrays only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const err = new Error();
      err.status = response.status;
      err.provider = "openrouter";

      if (response.status === 401) {
        err.message = "OpenRouter Error (401): Invalid API Key. Please verify your key in extension settings.";
      } else if (response.status === 402) {
        err.message = "OpenRouter Error (402): Insufficient credits. Please add credits at openrouter.ai or switch to a free model (e.g. google/gemini-2.0-flash-exp:free).";
      } else if (response.status === 429) {
        err.message = "OpenRouter Error (429): Rate limit exceeded. Please wait a moment or try another model.";
      } else {
        err.message = data.error?.message || `OpenRouter API HTTP ${response.status} error`;
      }
      throw err;
    }

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error("Invalid response structure from OpenRouter API");
    }

    const rawContent = data.choices[0].message.content;
    const parsed = parseAIResponseJSON(rawContent);

    return {
      result: parsed,
      provider: "openrouter",
      model: model
    };
  };

  return await retryWithBackoff(executeCall, 3, 1500);
}

// --- Google Gemini API Handler ---
async function handleGeminiRequest(questionsArray, storageData) {
  const API_KEY = storageData.userApiKey ? storageData.userApiKey.trim() : "";

  if (!API_KEY) {
    const err = new Error("Missing Google Gemini API key. Please save your API key in the extension settings.");
    err.status = 401;
    err.provider = "gemini";
    throw err;
  }

  const candidateModels = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-3-flash-preview"
  ];

  const prompt = buildPrompt(questionsArray);
  let lastError = null;

  for (const model of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const executeCall = async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const err = new Error();
        err.status = response.status;
        err.provider = "gemini";

        if (response.status === 404 || (data.error && data.error.message && data.error.message.includes("not found"))) {
          err.message = `Model ${model} not found`;
          throw err;
        }

        if (response.status === 429 || (data.error && data.error.message && data.error.message.includes("quota"))) {
          err.status = 429;
          err.message = "Gemini API Quota / Rate limit exceeded (429). Please wait a moment or switch to OpenRouter.";
          throw err;
        }

        if (data.error?.message?.includes("API_KEY_INVALID") || response.status === 400 && data.error?.message?.includes("API key")) {
          err.status = 401;
          err.message = "Google Gemini API Error: Invalid API Key. Please verify your key in settings.";
          throw err;
        }

        err.message = data.error?.message || `Gemini API HTTP ${response.status} error`;
        throw err;
      }

      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error("No response candidates returned from Gemini API");
      }

      const rawText = data.candidates[0].content.parts[0].text;
      const parsed = parseAIResponseJSON(rawText);

      return {
        result: parsed,
        provider: "gemini",
        model: model
      };
    };

    try {
      return await retryWithBackoff(executeCall, 3, 1500);
    } catch (err) {
      lastError = err;
      // If 404, try next candidate model
      if (err.status === 404 || err.message.includes("not found")) {
        console.warn(`Gemini model ${model} unavailable, trying fallback...`);
        continue;
      }
      // If key or quota error, propagate
      throw err;
    }
  }

  throw lastError || new Error("Failed to get response from Gemini API models.");
}
