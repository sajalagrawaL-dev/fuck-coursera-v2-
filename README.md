> [!CAUTION]
> ### ⚠️ Disclaimer: For Educational Purposes Only
> This extension was created strictly for **educational and learning purposes** to explore browser extension development, DOM manipulation, SPA orchestration, and API interception. 
> 
> * **No Liability:** The creators of this extension are not responsible for any consequences that may arise from using this tool.
> * **Academic Integrity:** Coursera has strict policies regarding academic integrity. Using this tool to automatically complete courses or solve quizzes may violate Coursera's Terms of Service and Honor Code.
> By using this open-source software, you agree that you are taking full responsibility for your own actions.

# fck coursera 🎓

<div align="center">
  <img src="icons/icon128.png" alt="fck coursera" width="128" />
  <p><em>speedrun your courses • v1.2.0</em></p>
</div>

A sleek, lightweight Chrome Extension to automate and navigate Coursera courses with full AI quiz-solving capabilities. Supports both **Google Gemini** and **OpenRouter** (including free models).

---

## ✨ Features

* **⚡ 1-Click Course Speedrun (Complete Lifecycle State Machine):**
  * Auto-completes all video lectures and reading materials across all modules in parallel background API calls.
  * Implements an explicit assignment state machine:
    `DETECT_ITEM -> WAIT_FOR_CONTENT_READY -> SOLVE_OR_HANDLE -> SAVE_OR_SUBMIT -> VERIFY_SAVED -> ADVANCE_NEXT`
  * Waits for Coursera's loading spinners and skeletons to disappear and questions to stabilize before answering.
  * Verifies submission persistence before advancing to the next item (never navigates while saves are in flight).
* **🛡️ Practice vs. Graded Assessment Protection:**
  * Distinguishes between practice quizzes and graded/timed assessments.
  * Configurable policy: **Pause on Graded/Timed (Default)** to prevent burning attempts unexpectedly, with interactive `[Solve Graded]` and `[Skip]` controls in the overlay.
* **🤖 Dual AI Provider Support (Gemini & OpenRouter):**
  * **Google Gemini:** Native support for `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-flash` with model fallback.
  * **OpenRouter:** Full integration with [OpenRouter](https://openrouter.ai/) supporting `openrouter/auto`, `:free` models (such as `google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.3-70b-instruct:free`), DeepSeek, OpenAI, Claude, etc.
  * Both API keys are stored separately so switching providers never wipes your keys.
* **🔄 429 Quota Handling & Exponential Backoff:**
  * Implements automatic exponential backoff with jitter on rate limits (HTTP 429) and transient 5xx server errors.
  * If quota is exhausted, pauses gracefully and provides a `[Retry / Resume]` button in the overlay instead of silently skipping assignments.
* **🛡️ SPA Navigation Guard (Run Tokens):**
  * Uses run-ID tokens to cancel stale asynchronous operations across Coursera's client-side route changes.
* **🖥️ Interactive Floating Dashboard:**
  * Real-time HUD showing current assignment, active sub-step, provider/model in use, and action buttons.

---

## 🚀 Setup & Usage Guide

### 1. Install or Reload the Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (or click the **🔄 Reload** icon if already loaded) and select `fck-courcera-main`.

### 2. Configure Your AI Provider

Click the **fck coursera** icon in your Chrome toolbar:

#### Option A: Using Google Gemini (Free)
1. In the **AI Solver Engine** section, click **Google Gemini**.
2. Get an API key from [Google AI Studio](https://ai.google.dev/aistudio).
3. Paste your key and click **Save**.

#### Option B: Using OpenRouter (Free or Paid Models)
1. In the **AI Solver Engine** section, click **OpenRouter**.
2. Get an API key from [OpenRouter Keys](https://openrouter.ai/keys).
3. Paste your key (`sk-or-v1-...`).
4. Choose or type your desired model slug:
   * `openrouter/auto` (automatically routes to the best model)
   * `google/gemini-2.0-flash-exp:free` (Free)
   * `meta-llama/llama-3.3-70b-instruct:free` (Free)
   * `deepseek/deepseek-chat`
   * `openai/gpt-4o-mini`
5. Click **Save**.

### 3. Choose Graded Assessment Policy
* **Pause on Graded/Timed (Recommended):** The runner will complete all videos and practice quizzes, and pause when reaching a graded/timed assessment so you can review or click `[⚡ Solve Graded]` or `[⏭️ Skip]`.
* **Auto-Solve All:** Speedruns through all materials, practice quizzes, and graded quizzes continuously.

### 4. Run the Speedrunner
* **For 1-Click Full Course:**
  1. Open the main page of any Coursera course (e.g. `https://www.coursera.org/learn/<course-name>`).
  2. Open the extension popup and click **⚡ Speedrun Entire Course**.
  3. Follow the live floating dashboard on your page!
* **For a Single Quiz:**
  1. Navigate to the quiz.
  2. Click **⚡ Auto-Solve & Submit Current**.

***

made with ❤️ by [Arya](https://sakura-tree.vercel.app/), [dietcoke](https://github.com/dietcokezerosugar) & [snc0x](https://x.com/snc0x)
