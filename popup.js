// =========================================================================
// fck-coursera popup.js - Settings & Speedrunner Controls
// =========================================================================

let currentProvider = "gemini";

// Helper: Show styled results in UI
const showResult = (text, type = "default") => {
  const resultDiv = document.getElementById("result");
  resultDiv.style.display = "block";
  resultDiv.innerText = text;

  if (type === "error") {
    resultDiv.style.color = "#ef4444";
    resultDiv.style.borderColor = "#f87171";
    resultDiv.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
  } else if (type === "success") {
    resultDiv.style.color = "#10b981";
    resultDiv.style.borderColor = "#34d399";
    resultDiv.style.backgroundColor = "rgba(16, 185, 129, 0.1)";
  } else {
    resultDiv.style.color = "var(--foreground)";
    resultDiv.style.borderColor = "var(--border)";
    resultDiv.style.backgroundColor = "var(--card)";
  }
};

// Helper: Update Speedrun UI Status
function updateSpeedrunUI(state) {
  const badge = document.getElementById("speedrunActiveBadge");
  const badgeText = document.getElementById("speedrunActiveText");
  const stopBtn = document.getElementById("stopSpeedrunBtn");
  const startBtn = document.getElementById("speedrunAllBtn");

  if (state && state.active) {
    badge.style.display = "flex";
    const total = state.assignments ? state.assignments.length : 0;
    const current = Math.min((state.currentIndex || 0) + 1, total);
    badgeText.innerText = `Running: Assignment ${current} of ${total} (${state.step || 'Active'})`;
    stopBtn.style.display = "inline-flex";
    startBtn.style.display = "none";
  } else {
    badge.style.display = "none";
    stopBtn.style.display = "none";
    startBtn.style.display = "inline-flex";
  }
}

// Helper: Switch Provider Tabs
function switchProvider(provider) {
  currentProvider = provider;
  const geminiBtn = document.getElementById("providerGeminiBtn");
  const openRouterBtn = document.getElementById("providerOpenRouterBtn");
  const geminiFields = document.getElementById("geminiFields");
  const openRouterFields = document.getElementById("openRouterFields");
  const activeEngineText = document.getElementById("activeEngineText");

  if (provider === "openrouter") {
    geminiBtn.classList.remove("active");
    openRouterBtn.classList.add("active");
    geminiFields.style.display = "none";
    openRouterFields.style.display = "flex";

    chrome.storage.local.get(["openRouterModel"], (res) => {
      const model = res.openRouterModel || "openrouter/auto";
      activeEngineText.innerText = `Active: OpenRouter (${model})`;
    });
  } else {
    openRouterBtn.classList.remove("active");
    geminiBtn.classList.add("active");
    openRouterFields.style.display = "none";
    geminiFields.style.display = "flex";
    activeEngineText.innerText = `Active: Google Gemini`;
  }

  chrome.storage.local.set({ aiProvider: provider });
}

// Load saved settings on startup
chrome.storage.local.get([
  "aiProvider",
  "userApiKey",
  "openRouterApiKey",
  "openRouterModel",
  "gradedHandlingMode",
  "speedrunRunnerState"
], (result) => {
  if (result.userApiKey) {
    document.getElementById("geminiKeyInput").value = result.userApiKey;
  }
  if (result.openRouterApiKey) {
    document.getElementById("openRouterKeyInput").value = result.openRouterApiKey;
  }
  if (result.openRouterModel) {
    document.getElementById("openRouterModelInput").value = result.openRouterModel;
  }
  if (result.gradedHandlingMode) {
    document.getElementById("gradedModeSelect").value = result.gradedHandlingMode;
  }

  switchProvider(result.aiProvider || "gemini");
  updateSpeedrunUI(result.speedrunRunnerState);
});

// Event: Provider Tab Click
document.getElementById("providerGeminiBtn").addEventListener("click", () => switchProvider("gemini"));
document.getElementById("providerOpenRouterBtn").addEventListener("click", () => switchProvider("openrouter"));

// Event: Save Gemini Key
document.getElementById("saveGeminiBtn").addEventListener("click", () => {
  const key = document.getElementById("geminiKeyInput").value.trim();
  chrome.storage.local.set({ userApiKey: key }, () => {
    const status = document.getElementById("geminiStatus");
    status.innerText = "Gemini key saved!";
    setTimeout(() => (status.innerText = ""), 2500);
  });
});

// Event: Save OpenRouter Key & Model
document.getElementById("saveOpenRouterBtn").addEventListener("click", () => {
  const key = document.getElementById("openRouterKeyInput").value.trim();
  const model = document.getElementById("openRouterModelInput").value.trim() || "openrouter/auto";
  chrome.storage.local.set({ 
    openRouterApiKey: key, 
    openRouterModel: model 
  }, () => {
    const status = document.getElementById("openRouterStatus");
    status.innerText = "OpenRouter settings saved!";
    document.getElementById("activeEngineText").innerText = `Active: OpenRouter (${model})`;
    setTimeout(() => (status.innerText = ""), 2500);
  });
});

// Event: Graded Mode Policy Change
document.getElementById("gradedModeSelect").addEventListener("change", (e) => {
  chrome.storage.local.set({ gradedHandlingMode: e.target.value });
});

// Helper: Ensure the active provider's API key is set
async function ensureActiveApiKey() {
  const data = await chrome.storage.local.get([
    "aiProvider",
    "userApiKey",
    "openRouterApiKey"
  ]);
  const provider = (data.aiProvider || "gemini").toLowerCase();

  if (provider === "openrouter") {
    if (!data.openRouterApiKey || data.openRouterApiKey.trim() === "") {
      showResult("Please enter and save your OpenRouter API Key (sk-or-...) first!", "error");
      switchProvider("openrouter");
      document.getElementById("openRouterKeyInput").focus();
      return false;
    }
  } else {
    if (!data.userApiKey || data.userApiKey.trim() === "") {
      showResult("Please enter and save your Google Gemini API Key first!", "error");
      switchProvider("gemini");
      document.getElementById("geminiKeyInput").focus();
      return false;
    }
  }
  return true;
}

// 1-Click Speedrun Master
document.getElementById("speedrunAllBtn").addEventListener("click", async () => {
  if (!(await ensureActiveApiKey())) return;

  const btn = document.getElementById("speedrunAllBtn");
  btn.disabled = true;
  btn.innerText = "Initializing 1-Click Speedrun...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes("coursera.org/learn/")) {
      showResult("Please navigate to a Coursera course (/learn/...) page first.", "error");
      btn.disabled = false;
      btn.innerText = "⚡ Speedrun Entire Course";
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: "startSpeedrunAll" }, (response) => {
      btn.disabled = false;
      btn.innerText = "⚡ Speedrun Entire Course";

      if (chrome.runtime.lastError) {
        showResult("Please refresh the Coursera page once to initialize.", "error");
        return;
      }

      if (response && response.error) {
        showResult("Error: " + response.error, "error");
      } else {
        showResult("⚡ Speedrun initiated! Complete lifecycle active. Check floating dashboard on page.", "success");
        setTimeout(() => {
          chrome.storage.local.get(["speedrunRunnerState"], (res) => {
            updateSpeedrunUI(res.speedrunRunnerState);
          });
        }, 1000);
      }
    });
  } catch (err) {
    showResult("Unexpected error occurred.", "error");
    btn.disabled = false;
    btn.innerText = "⚡ Speedrun Entire Course";
  }
});

// Stop Speedrun
document.getElementById("stopSpeedrunBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "stopSpeedrun" }, () => {
    updateSpeedrunUI(null);
    showResult("Speedrun stopped.", "default");
  });
});

// Auto-Solve & Submit Current Quiz
document.getElementById("solveAndSubmitBtn").addEventListener("click", async () => {
  if (!(await ensureActiveApiKey())) return;

  const btn = document.getElementById("solveAndSubmitBtn");
  btn.disabled = true;
  btn.innerText = "Solving & Submitting...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "solveAndSubmitCurrent" }, (response) => {
      btn.disabled = false;
      btn.innerText = "⚡ Auto-Solve & Submit Current";

      if (chrome.runtime.lastError) {
        showResult("Please refresh the page to use this feature.", "error");
        return;
      }

      if (response && response.error) {
        showResult(response.error, "error");
      } else {
        showResult("AI solver launched! Follow progress on the page banner.", "success");
      }
    });
  } catch (err) {
    btn.disabled = false;
    btn.innerText = "⚡ Auto-Solve & Submit Current";
  }
});

// Fill Only (No Submit)
document.getElementById("explainBtn").addEventListener("click", async () => {
  if (!(await ensureActiveApiKey())) return;

  const btn = document.getElementById("explainBtn");
  btn.disabled = true;
  btn.innerText = "Filling...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "solveQuizDirectly" }, (response) => {
      btn.disabled = false;
      btn.innerText = "Fill Only";

      if (chrome.runtime.lastError) {
        showResult("Please refresh the page to use this feature.", "error");
        return;
      }
      showResult("AI answers triggered. Review questions on the page.", "success");
    });
  } catch (err) {
    btn.disabled = false;
    btn.innerText = "Fill Only";
  }
});

// Complete Videos & Readings Only
document.getElementById("completeVideosBtn").addEventListener("click", async () => {
  const btn = document.getElementById("completeVideosBtn");
  btn.disabled = true;
  btn.innerText = "Completing...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "completeVideos" }, (response) => {
      btn.disabled = false;
      btn.innerText = "Complete Videos & Readings Only";

      if (chrome.runtime.lastError) {
        showResult("Please refresh the page to use this feature.", "error");
        return;
      }

      if (response && response.error) {
        showResult(response.error, "error");
      } else {
        showResult("Materials completing in background! Refresh page once done.", "success");
      }
    });
  } catch (err) {
    btn.disabled = false;
    btn.innerText = "Complete Videos & Readings Only";
  }
});

// Copy Questions Only
document.getElementById("showQuestionsBtn").addEventListener("click", async () => {
  const resultDiv = document.getElementById("result");
  resultDiv.style.display = "block";
  resultDiv.innerText = "Extracting questions...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "getSelection" }, (response) => {
    if (chrome.runtime.lastError) {
      resultDiv.innerText = "Please refresh the page to extract questions.";
      return;
    }

    if (response && response.data && response.data.length > 0) {
      resultDiv.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px;">
          <strong style="font-size: 11px; color: var(--foreground);">Extracted (${response.data.length} Qs):</strong>
          <button id="copyContentBtn" class="btn btn-primary" style="height: 22px; padding: 0 8px; width: auto; font-size: 10px; margin: 0;">Copy JSON</button>
        </div>
        <div style="white-space: pre-wrap; font-size: 11px; color: var(--muted); user-select: all; max-height: 100px; overflow-y: auto;">${JSON.stringify(response.data, null, 2)}</div>
      `;

      document.getElementById("copyContentBtn").addEventListener("click", (e) => {
        navigator.clipboard.writeText(JSON.stringify(response.data, null, 2)).then(() => {
          e.target.innerText = "Copied!";
          e.target.style.backgroundColor = "#10b981";
          setTimeout(() => {
            e.target.innerText = "Copy JSON";
            e.target.style.backgroundColor = "var(--primary)";
          }, 2000);
        });
      });
    } else {
      resultDiv.innerText = "No questions found on this page.";
    }
  });
});
