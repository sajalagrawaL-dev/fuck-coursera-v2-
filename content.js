// =========================================================================
// fck-coursera content.js - Robust Course Speedrunner & AI Assignment Solver
// =========================================================================

let capturedUserId = null;
let capturedCourseId = null;
let capturedAuthToken = null;
let capturedUserName = "Student";

// Global Run Token & In-Flight Guards to prevent SPA race conditions
let activeExecutionToken = null;
let isNavigationInProgress = false;
let authorizedGradedItemIds = new Set();

// Helper: Sleep delay that cancels if token becomes stale
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitWithToken(ms, token) {
    await wait(ms);
    if (token && token !== activeExecutionToken) {
        throw new Error("STALE_EXECUTION_TOKEN");
    }
}

// --- 1. Token & Context Capture from Intercepted Traffic ---
window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "fck-coursera-interceptor") {
        return;
    }

    const { url, contentType, response, request } = event.data;

    // Capture User Data from ApplicationStore
    if (response && response.context && response.context.dispatcher) {
        try {
            const userData = response.context.dispatcher.stores.ApplicationStore.userData;
            if (userData) {
                if (userData.id) capturedUserId = userData.id;
                if (userData.fullName) {
                    capturedUserName = userData.fullName;
                } else if (userData.firstName) {
                    capturedUserName = `${userData.firstName} ${userData.lastName || ''}`.trim();
                }
            }
        } catch (e) { }
    }

    // Capture User ID from URL
    if (!capturedUserId && request && request.url) {
        const userMatch = request.url.match(/user\/([0-9]+)/) || request.url.match(/userId=([0-9]+)/);
        if (userMatch) {
            capturedUserId = userMatch[1];
        }
    }

    // Capture CSRF3 Token from request headers
    if (request && request.headers) {
        if (Array.isArray(request.headers)) {
            request.headers.forEach(header => {
                if (header[0] && header[0].toLowerCase() === 'x-csrf3-token') {
                    capturedAuthToken = header[1];
                }
            });
        } else if (typeof request.headers === 'object') {
            for (const key in request.headers) {
                if (key.toLowerCase() === 'x-csrf3-token') {
                    capturedAuthToken = request.headers[key];
                }
            }
        }
    }

    // Capture Course Slug from API calls
    if (request && request.url && (request.url.includes("api/onDemandCourses.v1") || request.url.includes("slug="))) {
        try {
            const urlParams = new URL(request.url).searchParams;
            if (urlParams.has("slug")) {
                capturedCourseId = urlParams.get("slug");
            }
        } catch (e) { }
    }
});

// Fallback token accessors
function getCourseSlug() {
    if (capturedCourseId) return capturedCourseId;
    const matchUrl = window.location.pathname.match(/\/learn\/([^/]+)/);
    if (matchUrl) {
        capturedCourseId = matchUrl[1];
    }
    return capturedCourseId;
}

function getCsrfToken() {
    if (capturedAuthToken) return capturedAuthToken;
    const match = document.cookie.match(/(?:^|;\s*)CSRF3-Token=([^;]+)/i);
    if (match) {
        capturedAuthToken = match[1];
    }
    return capturedAuthToken;
}

function getUserId() {
    if (capturedUserId) return capturedUserId;
    const userCookie = document.cookie.match(/(?:userId|c_user|member_id)=([0-9]+)/i);
    if (userCookie) {
        capturedUserId = userCookie[1];
        return capturedUserId;
    }
    return "~"; // Coursera API accepts "~" representing the current authenticated user
}

// React Native Setter Helper: dispatches synthetic events so React updates its internal state
function setNativeValue(element, value) {
    if (!element) return;
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
        valueSetter.call(element, value);
    } else {
        element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

// Fuzzy matching for option texts
function isOptionMatch(optionText, targetAnswers) {
    if (!targetAnswers || !targetAnswers.length) return false;
    const cleanOpt = optionText.toLowerCase().replace(/^[a-d\d][\.\)]\s*/i, '').replace(/\s+/g, ' ').trim();
    return targetAnswers.some(ans => {
        if (!ans) return false;
        const cleanAns = ans.toString().toLowerCase().replace(/^[a-d\d][\.\)]\s*/i, '').replace(/\s+/g, ' ').trim();
        return cleanOpt === cleanAns || cleanOpt.includes(cleanAns) || cleanAns.includes(cleanOpt);
    });
}

// --- 2. Floating Live Speedrun Dashboard & Overlay ---
function renderSpeedrunWidget(state) {
    let widget = document.getElementById("fck-speedrun-dashboard");
    if (!widget) {
        widget = document.createElement("div");
        widget.id = "fck-speedrun-dashboard";
        widget.style.position = "fixed";
        widget.style.top = "20px";
        widget.style.right = "20px";
        widget.style.zIndex = "9999999";
        widget.style.backgroundColor = "rgba(10, 10, 10, 0.96)";
        widget.style.color = "#ffffff";
        widget.style.border = "1px solid #333333";
        widget.style.borderRadius = "12px";
        widget.style.padding = "16px 18px";
        widget.style.boxShadow = "0 12px 32px rgba(0,0,0,0.75)";
        widget.style.fontFamily = "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        widget.style.fontSize = "13px";
        widget.style.width = "340px";
        widget.style.backdropFilter = "blur(10px)";
        widget.style.transition = "all 0.3s ease";
        document.body.appendChild(widget);
    }

    const total = state.assignments ? state.assignments.length : 0;
    const current = Math.min((state.currentIndex || 0) + 1, total);
    const item = state.assignments && state.assignments[state.currentIndex];
    const itemName = item ? item.name : "Initializing...";
    const itemType = item ? (item.type || "assignment") : "";
    const pct = total > 0 ? Math.round(((current - 1) / total) * 100) : 0;
    const currentStep = state.step || "DETECT_ITEM";
    const statusText = state.statusText || "Processing...";
    const isPaused = currentStep.startsWith("PAUSED");

    // Action button area for Paused states
    let actionsHtml = "";
    if (currentStep === "PAUSED_GRADED") {
        actionsHtml = `
            <div style="background: rgba(234, 179, 8, 0.12); border: 1px solid #eab308; border-radius: 8px; padding: 10px; margin-top: 10px;">
                <div style="font-size: 11px; color: #fde047; font-weight: 600; margin-bottom: 8px;">
                    ⚠️ Paused on Graded/Timed Assessment to protect your attempts!
                </div>
                <div style="display: flex; gap: 6px;">
                    <button id="fck-solve-graded-btn" style="flex: 1; background: #10b981; color: white; border: none; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">⚡ Solve Graded</button>
                    <button id="fck-skip-graded-btn" style="flex: 1; background: #374151; color: #d1d5db; border: none; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 600; cursor: pointer;">⏭️ Skip</button>
                </div>
            </div>
        `;
    } else if (currentStep === "PAUSED_ERROR") {
        actionsHtml = `
            <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid #ef4444; border-radius: 8px; padding: 10px; margin-top: 10px;">
                <div style="font-size: 11px; color: #fca5a5; font-weight: 600; margin-bottom: 8px;">
                    ❌ Paused: ${state.lastErrorMessage || "API Error"}
                </div>
                <button id="fck-retry-step-btn" style="width: 100%; background: #3b82f6; color: white; border: none; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">🔄 Retry / Resume</button>
            </div>
        `;
    } else if (currentStep === "PAUSED_SUBMISSION") {
        actionsHtml = `
            <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid #ef4444; border-radius: 8px; padding: 10px; margin-top: 10px;">
                <div style="font-size: 11px; color: #fca5a5; font-weight: 600; margin-bottom: 8px;">
                    ⚠️ Submission Unconfirmed: ${state.lastErrorMessage || "Modal was not completed"}
                </div>
                <div style="display: flex; gap: 6px;">
                    <button id="fck-retry-submit-btn" style="flex: 1; background: #3b82f6; color: white; border: none; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">🔄 Retry Submit</button>
                    <button id="fck-skip-submit-btn" style="flex: 1; background: #374151; color: #d1d5db; border: none; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 600; cursor: pointer;">⏭️ Skip</button>
                </div>
            </div>
        `;
    }

    widget.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                <span style="display:inline-block; animation: spin 1.2s linear infinite;">⚡</span>
                <span>Coursera Speedrunner</span>
            </div>
            <button id="fck-stop-runner-btn" style="background: #ef4444; color: white; border: none; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; transition: opacity 0.2s;">Stop</button>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #a3a3a3; margin-bottom: 4px;">
            <span>Assignment ${current} of ${total}</span>
            <span style="text-transform: uppercase; font-size: 10px; background: #1f2937; padding: 2px 6px; border-radius: 4px; color: #9ca3af;">${itemType}</span>
        </div>
        <div style="font-weight: 600; font-size: 13px; color: #f3f4f6; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${itemName}">
            ${itemName}
        </div>
        <div style="background: #262626; border-radius: 6px; height: 6px; width: 100%; overflow: hidden; margin-bottom: 10px;">
            <div style="background: linear-gradient(90deg, #10b981, #06b6d4); height: 100%; width: ${pct}%; transition: width 0.4s ease;"></div>
        </div>
        <div id="fck-widget-status" style="font-size: 12px; color: ${isPaused ? '#fde047' : '#38bdf8'}; line-height: 1.4;">
            ${statusText}
        </div>
        ${actionsHtml}
    `;

    // Spin animation stylesheet
    if (!document.getElementById("fck-coursera-styles")) {
        const style = document.createElement("style");
        style.id = "fck-coursera-styles";
        style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
        document.head.appendChild(style);
    }

    // Attach button listeners
    const stopBtn = document.getElementById("fck-stop-runner-btn");
    if (stopBtn) stopBtn.addEventListener("click", () => stopSpeedrun());

    const solveGradedBtn = document.getElementById("fck-solve-graded-btn");
    if (solveGradedBtn && item) {
        solveGradedBtn.addEventListener("click", () => {
            authorizedGradedItemIds.add(item.id);
            state.step = "WAIT_FOR_CONTENT_READY";
            state.statusText = "Authorized: Solving graded assignment... 🚀";
            chrome.storage.local.set({ speedrunRunnerState: state }, () => {
                renderSpeedrunWidget(state);
                processCurrentAssignmentStep();
            });
        });
    }

    const skipGradedBtn = document.getElementById("fck-skip-graded-btn");
    if (skipGradedBtn) {
        skipGradedBtn.addEventListener("click", () => {
            state.statusText = "Skipped by user: Graded assignment protected. Moving on...";
            chrome.storage.local.set({ speedrunRunnerState: state }, () => {
                renderSpeedrunWidget(state);
                advanceToNextAssignment(state, "User skipped graded assessment");
            });
        });
    }

    const retryBtn = document.getElementById("fck-retry-step-btn");
    if (retryBtn) {
        retryBtn.addEventListener("click", () => {
            state.step = "SOLVE_OR_HANDLE";
            state.statusText = "Retrying AI solution... 🔄";
            chrome.storage.local.set({ speedrunRunnerState: state }, () => {
                renderSpeedrunWidget(state);
                processCurrentAssignmentStep();
            });
        });
    }

    const retrySubmitBtn = document.getElementById("fck-retry-submit-btn");
    if (retrySubmitBtn) {
        retrySubmitBtn.addEventListener("click", () => {
            state.step = "SAVE_OR_SUBMIT";
            state.statusText = "Retrying submission... 🔄";
            chrome.storage.local.set({ speedrunRunnerState: state }, () => {
                renderSpeedrunWidget(state);
                processCurrentAssignmentStep();
            });
        });
    }

    const skipSubmitBtn = document.getElementById("fck-skip-submit-btn");
    if (skipSubmitBtn) {
        skipSubmitBtn.addEventListener("click", () => {
            state.statusText = "Skipped by user after submission warning.";
            chrome.storage.local.set({ speedrunRunnerState: state }, () => {
                renderSpeedrunWidget(state);
                advanceToNextAssignment(state, "Skipped by user after modal stall");
            });
        });
    }
}

function updateWidgetStatus(text, step = null) {
    const el = document.getElementById("fck-widget-status");
    if (el) el.innerText = text;
    chrome.storage.local.get(["speedrunRunnerState"], (res) => {
        if (res.speedrunRunnerState && res.speedrunRunnerState.active) {
            res.speedrunRunnerState.statusText = text;
            if (step) res.speedrunRunnerState.step = step;
            chrome.storage.local.set({ speedrunRunnerState: res.speedrunRunnerState });
        }
    });
}

function hideSpeedrunWidget() {
    const widget = document.getElementById("fck-speedrun-dashboard");
    if (widget) {
        widget.style.opacity = "0";
        setTimeout(() => widget.remove(), 300);
    }
}

function showOrUpdateBanner(text, type = "info") {
    let banner = document.getElementById("fck-coursera-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "fck-coursera-banner";
        banner.style.position = "fixed";
        banner.style.bottom = "30px";
        banner.style.left = "50%";
        banner.style.transform = "translateX(-50%)";
        banner.style.zIndex = "9999999";
        banner.style.padding = "14px 28px";
        banner.style.color = "white";
        banner.style.fontWeight = "600";
        banner.style.borderRadius = "50px";
        banner.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
        banner.style.fontFamily = "'Outfit', system-ui, -apple-system, sans-serif";
        banner.style.fontSize = "15px";
        banner.style.transition = "all 0.3s ease";
        document.body.appendChild(banner);
    }

    if (type === "success") {
        banner.style.backgroundColor = "#10b981";
        banner.innerHTML = "✅ " + text;
    } else if (type === "error") {
        banner.style.backgroundColor = "#ef4444";
        banner.innerHTML = "❌ " + text;
    } else {
        banner.style.backgroundColor = "#2563eb";
        banner.innerHTML = `<span style="display:inline-block; margin-right:8px; animation: spin 1s linear infinite;">⏳</span> ` + text;
    }
}

function hideBanner() {
    const banner = document.getElementById("fck-coursera-banner");
    if (banner) {
        banner.style.opacity = "0";
        setTimeout(() => banner.remove(), 300);
    }
}

// --- 3. DOM Scraping for Questions & Interactive Elements ---
function scrapeAssessment() {
    const scrapedAssessment = [];

    const promptNodes = document.querySelectorAll('[id^="prompt-"] [data-testid="cml-viewer"], [id^="prompt-"]');
    const questionBlocks = [];

    if (promptNodes.length > 0) {
        promptNodes.forEach(pn => {
            const block = pn.closest('.css-1erl2aq, .css-12u8wr5, [data-testid*="part-"], .rc-FormPart, fieldset, [role="group"]') || pn.parentElement?.parentElement;
            if (block && !questionBlocks.includes(block)) {
                questionBlocks.push(block);
            }
        });
    }

    if (questionBlocks.length === 0) {
        const fallbackNodes = document.querySelectorAll('.css-1erl2aq, .css-12u8wr5, [data-testid="part-Submission_RichTextQuestion"], div[class*="QuestionPart"], div[class*="question-container"]');
        fallbackNodes.forEach(fb => questionBlocks.push(fb));
    }

    questionBlocks.forEach((block, index) => {
        const promptNode = block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]') ||
                           block.querySelector('[id^="prompt-"]') ||
                           block.querySelector('[data-testid="cml-viewer"]') ||
                           block.querySelector('legend, h3, h4, p');

        if (!promptNode) return;
        const questionText = promptNode.innerText.trim();

        const options = [];
        let questionType = 'unknown';

        const optionContainers = block.querySelectorAll('.rc-Option, label[class*="option" i], [data-testid*="option" i], [role="radiogroup"] label, [role="group"] label');

        if (optionContainers.length > 0) {
            optionContainers.forEach(opt => {
                const textNode = opt.querySelector('[data-testid="cml-viewer"]') || opt;
                const inputNode = opt.querySelector('input');

                if (textNode) {
                    const text = textNode.innerText.trim();
                    if (text && !options.includes(text)) {
                        options.push(text);
                    }
                }
                if (inputNode && questionType === 'unknown') {
                    questionType = inputNode.type === 'radio' ? 'single_answer' : 'multiple_answer';
                }
            });
        }

        if (options.length === 0) {
            const inputs = block.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            if (inputs.length > 0) {
                inputs.forEach(inp => {
                    const label = inp.closest('label') || inp.parentElement;
                    const text = label ? label.innerText.trim() : "";
                    if (text && !options.includes(text)) {
                        options.push(text);
                    }
                    if (questionType === 'unknown') {
                        questionType = inp.type === 'radio' ? 'single_answer' : 'multiple_answer';
                    }
                });
            }
        }

        if (options.length === 0) {
            const slateEditor = block.querySelector('[data-slate-editor="true"], [contenteditable="true"]');
            const standardInput = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]), textarea');

            if (slateEditor) {
                questionType = 'essay';
            } else if (standardInput) {
                questionType = 'text_input';
            }
        }

        scrapedAssessment.push({
            questionNumber: index + 1,
            type: questionType,
            question: questionText,
            options: options
        });
    });

    return scrapedAssessment;
}

// --- 4. Applying AI Answers into DOM ---
function applyAnswersToDOM(correctAnswers) {
    if (!correctAnswers || !Array.isArray(correctAnswers)) return;

    const promptNodes = document.querySelectorAll('[id^="prompt-"] [data-testid="cml-viewer"], [id^="prompt-"]');
    const questionBlocks = [];

    if (promptNodes.length > 0) {
        promptNodes.forEach(pn => {
            const block = pn.closest('.css-1erl2aq, .css-12u8wr5, [data-testid*="part-"], .rc-FormPart, fieldset, [role="group"]') || pn.parentElement?.parentElement;
            if (block && !questionBlocks.includes(block)) {
                questionBlocks.push(block);
            }
        });
    }

    if (questionBlocks.length === 0) {
        const fallbackNodes = document.querySelectorAll('.css-1erl2aq, .css-12u8wr5, [data-testid="part-Submission_RichTextQuestion"], div[class*="QuestionPart"]');
        fallbackNodes.forEach(fb => questionBlocks.push(fb));
    }

    questionBlocks.forEach((block, index) => {
        const questionNum = index + 1;
        const answerData = correctAnswers.find(q => q.questionNumber === questionNum);
        if (!answerData || !answerData.correctOptions || answerData.correctOptions.length === 0) return;

        // 1. Multiple Choice / Checkbox
        const inputs = block.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        if (inputs.length > 0) {
            inputs.forEach(inputNode => {
                const label = inputNode.closest('label') || inputNode.parentElement;
                const textNode = label ? (label.querySelector('[data-testid="cml-viewer"]') || label) : null;
                const optionText = textNode ? textNode.innerText.trim() : "";

                const shouldBeSelected = isOptionMatch(optionText, answerData.correctOptions);

                if (shouldBeSelected && !inputNode.checked) {
                    inputNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    inputNode.click();
                    inputNode.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (!shouldBeSelected && inputNode.checked && inputNode.type === 'checkbox') {
                    inputNode.click();
                    inputNode.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            return;
        }

        // 2. Text Input & Essay
        const textToType = answerData.correctOptions[0] || "";
        const slateEditor = block.querySelector('[data-slate-editor="true"], [contenteditable="true"]');
        const standardInput = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), textarea');

        if (slateEditor) {
            slateEditor.focus();
            try {
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, textToType);
            } catch (e) {
                slateEditor.textContent = textToType;
            }
            slateEditor.dispatchEvent(new Event('input', { bubbles: true }));
            slateEditor.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (standardInput) {
            standardInput.focus();
            setNativeValue(standardInput, textToType);
            standardInput.blur();
        }
    });

    console.log("[Solver] Applied answers to DOM successfully.");
}

// --- 5. Assessment Categorization & Stability Detection ---
function detectAssessmentType(item) {
    const pageText = (document.body ? document.body.innerText : "").toLowerCase();
    const itemType = (item.type || "").toLowerCase();
    const itemName = (item.name || "").toLowerCase();

    // Check for explicit timed indicators
    const isTimed = pageText.includes("time limit:") ||
                    pageText.includes("timed quiz") ||
                    pageText.includes("timed exam") ||
                    pageText.includes("minutes remaining") ||
                    pageText.includes("time remaining") ||
                    itemName.includes("timed");

    // Check for graded indicators
    const isExplicitlyGraded = itemType === "exam" ||
                               itemName.includes("graded") ||
                               pageText.includes("graded quiz") ||
                               pageText.includes("graded assignment") ||
                               pageText.includes("graded assessment") ||
                               pageText.includes("weight:") ||
                               pageText.includes("% of your grade") ||
                               pageText.includes("attempts remaining") ||
                               pageText.includes("attempts left") ||
                               pageText.includes("3 attempts every");

    // Check for practice indicators
    const isPractice = itemName.includes("practice") ||
                       pageText.includes("practice quiz") ||
                       pageText.includes("practice assignment") ||
                       pageText.includes("grade does not count");

    const isGraded = (isExplicitlyGraded || isTimed) && !isPractice;

    return {
        isGraded: isGraded,
        isTimed: isTimed,
        isPractice: !isGraded,
        reason: isTimed ? "Timed quiz" : (isGraded ? "Graded assessment" : "Practice quiz")
    };
}

// Wait for Coursera loading skeletons and spinners to vanish and questions to stabilize
async function waitForContentReady(token, timeoutMs = 12000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        await waitWithToken(400, token);

        // Check if Coursera loading spinners or skeletons are active
        const spinners = document.querySelectorAll('.cds-spinner, .rc-Loading, [role="progressbar"], div[class*="loading" i], div[class*="skeleton" i], [data-testid*="loading" i]');
        if (spinners.length > 0) {
            continue; // Still loading
        }

        // If on landing page with start button, content is ready
        if (findStartButton()) {
            return true;
        }

        // If on already-passed page, content is ready
        if (isAssignmentAlreadyPassed()) {
            return true;
        }

        // Check for question blocks stability
        const questions1 = scrapeAssessment();
        if (questions1.length > 0) {
            await waitWithToken(500, token);
            const questions2 = scrapeAssessment();
            if (questions2.length >= questions1.length) {
                return true; // Questions stabilized
            }
        }

        // Check for "Mark as completed" button on labs/readings
        if (findMarkCompletedButton()) {
            return true;
        }
    }

    return true; // Proceed on timeout
}

// --- 6. Coursera Quiz Interaction Helpers (Start, Honor Code, Submit, Confirm) ---
function findStartButton() {
    const candidates = Array.from(document.querySelectorAll('button, a[role="button"], a.cds-button, [data-testid*="start" i]'));
    for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (/^(start assignment|start quiz|start|resume assignment|resume quiz|resume|take quiz|try again|continue)/i.test(text) ||
            (text.includes('start') || text.includes('resume') || text.includes('try again') || text.includes('take quiz'))) {
            if (el.offsetParent !== null && !el.disabled) {
                return el;
            }
        }
    }
    return null;
}

function findAndCheckHonorCode() {
    let count = 0;
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
        const container = cb.closest('label') || cb.closest('div') || cb.parentElement;
        const text = (container ? container.innerText : '').toLowerCase();
        const aria = (cb.getAttribute('aria-label') || '').toLowerCase();

        if (text.includes('honor code') || text.includes('submitting') || text.includes('own work') ||
            text.includes('understand and agree') || text.includes('i agree') || text.includes('acknowledge') ||
            text.includes('select the checkbox') || text.includes('confirm this work') ||
            aria.includes('honor code') || aria.includes('agree')) {
            if (!cb.checked) {
                cb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                cb.click();
                if (!cb.checked) {
                    cb.checked = true;
                }
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                count++;
            }
        }
    }

    // Fill signature input if present
    const nameInputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const inp of nameInputs) {
        const placeholder = (inp.placeholder || '').toLowerCase();
        const ariaLabel = (inp.getAttribute('aria-label') || '').toLowerCase();
        const idOrName = (inp.id || inp.name || '').toLowerCase();

        if (placeholder.includes('name') || placeholder.includes('signature') ||
            ariaLabel.includes('name') || ariaLabel.includes('signature') ||
            idOrName.includes('name') || idOrName.includes('signature')) {
            if (!inp.value || inp.value.trim() === '') {
                setNativeValue(inp, capturedUserName || "Student");
                count++;
            }
        }
    }

    return count;
}

// Dynamic cds-<XYZ> class matcher helper: matches dynamic cds-\d{3} or cds-\d+ without hardcoding numbers
function getCdsDynamicClass(element) {
    if (!element || !element.classList) return null;
    for (const cls of element.classList) {
        const match = cls.match(/^cds-(\d{3})$/) || cls.match(/^cds-(\d+)$/);
        if (match) {
            return {
                className: cls,
                xyz: match[1]
            };
        }
    }
    return null;
}

// Reliable Event Dispatcher: simulates full Pointer/Mouse/Click event sequence for modern React/SPA buttons
function reliablyClickElement(element) {
    if (!element) return false;
    try {
        element.scrollIntoView({ behavior: 'instant', block: 'center' });
    } catch (e) { }

    try {
        element.focus();
    } catch (e) { }

    const mouseEventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 1
    };

    // Full event sequence: pointerover, mouseover, pointerdown, mousedown, pointerup, mouseup, click
    try { element.dispatchEvent(new PointerEvent('pointerover', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new MouseEvent('mouseover', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new PointerEvent('pointerdown', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new MouseEvent('mousedown', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new PointerEvent('pointerup', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new MouseEvent('mouseup', mouseEventInit)); } catch (e) { }
    try { element.dispatchEvent(new MouseEvent('click', mouseEventInit)); } catch (e) { }
    try { element.click(); } catch (e) { }

    // If element contains an inner span (e.g. CDS button label), also trigger click on it
    const innerSpan = element.querySelector('span');
    if (innerSpan) {
        try { innerSpan.click(); } catch (e) { }
    }

    return true;
}

// Locate the primary quiz submit button (First Submit Button on page)
function findFirstSubmitButton() {
    // 1. Match candidates via stable attributes and containers (avoiding hardcoded cds-116/cds-288)
    const specificSelectors = [
        '[data-e2e="AttemptSubmitControls_buttons"] button',
        'button.cds-button-disableElevation.cds-button-primary.css-dxhcv5',
        'button.cds-button-primary.css-dxhcv5',
        'button[data-testid="submit-button"]',
        'button[aria-label="Submit"][type="button"]',
        'button[aria-label="Submit"]'
    ];

    for (const sel of specificSelectors) {
        const matches = Array.from(document.querySelectorAll(sel));
        for (const btn of matches) {
            // Strictly exclude any button inside the modal dialog
            if (btn.closest('#dialog-content, [data-testid="SubmitDialog_content"], [data-testid="SubmitDialog_controls"], [role="dialog"], [role="alertdialog"], .cds-modal')) {
                continue;
            }

            const isEnabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
            const rect = btn.getBoundingClientRect();
            if (!isEnabled || rect.width === 0 || rect.height === 0) continue;

            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

            // Check dynamic cds-<XYZ> class (/^cds-\d{3}$/ or /^cds-\d+$/)
            const cdsMatch = getCdsDynamicClass(btn);
            const classList = btn.classList;
            const hasStableClasses = classList.contains('cds-button-disableElevation') &&
                                     classList.contains('cds-button-primary') &&
                                     classList.contains('css-dxhcv5');
            const hasTestId = btn.getAttribute('data-testid') === 'submit-button';
            const hasAria = (btn.getAttribute('aria-label') || '').trim().toLowerCase() === 'submit';
            const isInsideAttemptControls = !!btn.closest('[data-e2e="AttemptSubmitControls_buttons"]');

            // Criteria: dynamic cds-<XYZ> + stable classes/attributes
            if ((cdsMatch && hasStableClasses) || (isInsideAttemptControls && (hasTestId || hasAria || hasStableClasses)) || hasTestId) {
                btn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
                btn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
                console.log(`[Submit] Matched First Submit Button with dynamic class: ${btn._cdsClass} (XYZ: ${btn._cdsXyz})`, btn);
                return btn;
            }
        }
    }

    // 2. Generic fallback search across the page (outside dialogs)
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.cds-button'));
    for (const btn of buttons) {
        if (btn.closest('#dialog-content, [data-testid="SubmitDialog_content"], [data-testid="SubmitDialog_controls"], [role="dialog"], [role="alertdialog"], .cds-modal, div[class*="modal" i]')) {
            continue;
        }

        const isEnabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        if (!isEnabled) continue;

        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();

        if (testId === "submit-button" || aria === "submit" || text === "submit" ||
            /^(submit|submit quiz|submit assignment|submit answers)/i.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const cdsMatch = getCdsDynamicClass(btn);
                btn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
                btn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
                return btn;
            }
        }
    }

    return null;
}

// Backwards-compatible alias for existing callers
function findSubmitButton() {
    return findFirstSubmitButton();
}

// Poll for First Submit Button to be enabled (aria-disabled !== 'true') after honor code is checked
async function waitForFirstSubmitButton(token, maxWaitMs = 6000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        if (token && token !== activeExecutionToken) throw new Error("STALE_EXECUTION_TOKEN");
        const btn = findFirstSubmitButton();
        if (btn) return btn;
        await waitWithToken(250, token);
    }
    return null;
}

// Locate the active "Ready to submit?" confirmation modal/dialog in Coursera's DOM
function getActiveSubmissionModal() {
    // 1. Direct targeted selector from Coursera DOM (#dialog-content / [data-testid="SubmitDialog_content"])
    const specificDialog = document.querySelector('#dialog-content, [data-testid="SubmitDialog_content"], [data-testid="SubmitDialog_controls"]');
    if (specificDialog) {
        const modalContainer = specificDialog.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .cds-modal') || specificDialog;
        const rect = modalContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            const style = window.getComputedStyle(modalContainer);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return modalContainer;
            }
        }
    }

    // 2. Check all elements matching dialog/modal roles or classes
    const candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .cds-modal, div[class*="modal" i], div[class*="dialog" i], div[class*="ModalWrapper" i], div[class*="ModalPortal" i]'
    ));

    for (const dialog of candidates) {
        // Exclude our own extension widgets
        if (dialog.closest('#speedrun-runner-overlay, #gemini-floating-banner, #fck-speedrun-dashboard, #fck-coursera-banner')) {
            continue;
        }

        const rect = dialog.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(dialog);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const text = (dialog.innerText || '').toLowerCase();
        if (text.includes("ready to submit") ||
            text.includes("submit your") ||
            text.includes("submit quiz") ||
            text.includes("submit assignment") ||
            text.includes("are you sure you want to submit") ||
            text.includes("won't be able to change") ||
            text.includes("can't change your answers") ||
            text.includes("cannot change your answers") ||
            text.includes("unanswered questions") ||
            text.includes("submitting...")) {
            return dialog;
        }
    }

    // 3. Fallback: Search visible elements for key modal heading / body text
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, p, span, div'));
    for (const el of headings) {
        if (el.closest('#speedrun-runner-overlay, #gemini-floating-banner, #fck-speedrun-dashboard, #fck-coursera-banner')) {
            continue;
        }
        const text = (el.innerText || '').trim().toLowerCase();
        if (text === "ready to submit?" || 
            text.includes("ready to submit") || 
            text.includes("are you sure you want to submit") ||
            text.includes("submit your assignment?") ||
            text.includes("submit your quiz?")) {
            
            // Find its top-level floating/modal container
            const container = el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .cds-modal, div[class*="modal" i], div[class*="dialog" i]') ||
                              el.closest('div[style*="z-index"], div[class*="portal" i], div[class*="overlay" i]') ||
                              el.parentElement?.parentElement;
            if (container) {
                const rect = container.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return container;
                }
            }
        }
    }

    return null;
}

// Locate the primary confirmation "Submit" button specifically inside the visible modal/dialog (Second Submit Button)
function getModalSubmitButton(modal) {
    if (!modal) {
        modal = getActiveSubmissionModal() || document;
    }

    // 1. Candidate search using stable containers and attributes (no hardcoded cds-116/cds-288)
    const specificSelectors = [
        '[data-testid="SubmitDialog_controls"] button',
        '[data-testid="AttemptViewSubmitControls_buttons"] button',
        '#dialog-content button',
        'button.cds-button-disableElevation.cds-button-primary.css-1haxtzk',
        'button.cds-button-primary.css-1haxtzk',
        'button[data-testid="dialog-submit-button"]'
    ];

    for (const sel of specificSelectors) {
        const matches = Array.from(modal.querySelectorAll(sel));
        if (matches.length === 0 && modal !== document) {
            matches.push(...Array.from(document.querySelectorAll(sel)));
        }

        for (const btn of matches) {
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            const isCancel = testId === "dialog cancel button" || text.includes("cancel");
            if (isCancel) continue;

            const isEnabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
            const rect = btn.getBoundingClientRect();
            if (!isEnabled || rect.width === 0 || rect.height === 0) continue;

            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

            // Check dynamic cds-<XYZ> class
            const cdsMatch = getCdsDynamicClass(btn);
            const classList = btn.classList;
            const hasStableClasses = classList.contains('cds-button-disableElevation') &&
                                     classList.contains('cds-button-primary') &&
                                     classList.contains('css-1haxtzk');
            const hasDialogTestId = testId === 'dialog-submit-button';
            const isInsideDialogControls = !!btn.closest('[data-testid="SubmitDialog_controls"], [data-testid="AttemptViewSubmitControls_buttons"], #dialog-content');

            if ((cdsMatch && hasStableClasses) || (isInsideDialogControls && (hasDialogTestId || hasStableClasses)) || hasDialogTestId) {
                btn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
                btn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
                console.log(`[Submit] Matched Second Submit Button with dynamic class: ${btn._cdsClass} (XYZ: ${btn._cdsXyz})`, btn);
                return btn;
            }
        }
    }

    // 2. Comprehensive search within modal container
    const buttons = Array.from(modal.querySelectorAll(
        'button, [role="button"], a.cds-button, a[role="button"], input[type="button"], input[type="submit"]'
    )).filter(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
        return true;
    });

    if (buttons.length === 0) return null;

    const isCancelButton = (btn) => {
        const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        return testId === "dialog cancel button" ||
               text.includes("cancel") || 
               text.includes("go back") || 
               text.includes("close") || 
               text.includes("return") || 
               text.includes("continue editing") ||
               text.includes("keep editing") ||
               aria.includes("close") || 
               aria.includes("cancel") ||
               testId.includes("cancel") ||
               testId.includes("close");
    };

    // Priority 1: Match buttons whose label explicitly equals or starts with Submit / Confirm (excluding Cancel)
    for (const btn of buttons) {
        if (isCancelButton(btn)) continue;
        const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();

        if (testId === "dialog-submit-button" ||
            text === "submit" ||
            text === "submit assignment" ||
            text === "submit quiz" ||
            text === "yes, submit" ||
            text === "confirm" ||
            text === "submit attempt" ||
            text.startsWith("submit ") ||
            aria === "submit" ||
            aria.startsWith("submit") ||
            testId.includes("submit")) {
            const cdsMatch = getCdsDynamicClass(btn);
            btn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
            btn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
            return btn;
        }
    }

    // Priority 2: Primary styled button inside the modal that is not cancel
    for (const btn of buttons) {
        if (isCancelButton(btn)) continue;
        const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isPrimary = (btn.className && (btn.className.includes("primary") || btn.className.includes("cds-button-primary") || btn.className.includes("css-1haxtzk"))) || 
                          btn.getAttribute("data-track-component") === "submit_button" ||
                          btn.getAttribute("type") === "submit";

        if (isPrimary || text.includes("submit")) {
            const cdsMatch = getCdsDynamicClass(btn);
            btn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
            btn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
            return btn;
        }
    }

    // Priority 3: Return the last non-cancel button in the modal
    const nonCancelButtons = buttons.filter(btn => !isCancelButton(btn));
    if (nonCancelButtons.length > 0) {
        const lastBtn = nonCancelButtons[nonCancelButtons.length - 1];
        const cdsMatch = getCdsDynamicClass(lastBtn);
        lastBtn._cdsClass = cdsMatch ? cdsMatch.className : 'cds-dynamic';
        lastBtn._cdsXyz = cdsMatch ? cdsMatch.xyz : 'N/A';
        return lastBtn;
    }

    return null;
}

// Delay + Second Submit Button (Inside "Ready to submit?" Modal)
async function triggerModalSubmission(token, maxWaitMs = 6000) {
    const startTime = Date.now();

    // Brief initial delay (~500–1200 ms) allowing Coursera React transition to render #dialog-content / [data-testid="SubmitDialog_content"]
    await waitWithToken(800, token);

    while (Date.now() - startTime < maxWaitMs) {
        if (token && token !== activeExecutionToken) throw new Error("STALE_EXECUTION_TOKEN");

        const modal = getActiveSubmissionModal();
        if (modal) {
            const modalSubmitBtn = getModalSubmitButton(modal);
            if (modalSubmitBtn) {
                const cdsInfo = modalSubmitBtn._cdsClass || '(dynamic cds)';
                const xyzInfo = modalSubmitBtn._cdsXyz || 'N/A';
                console.log(`[Submit] Found Second Submit Button (${cdsInfo}, XYZ: ${xyzInfo}). Triggering click...`, modalSubmitBtn);
                reliablyClickElement(modalSubmitBtn);
                await waitWithToken(800, token);
                return true;
            }
        }
        await waitWithToken(300, token);
    }

    console.warn("[Submit] Second submit button not found within wait period.");
    return false;
}

// Unified Two-Step Submit Sequence: First Submit Button -> Delay -> Second Modal Submit Button
async function executeTwoStepQuizSubmission(token) {
    // 1. Locate First Submit Button (After Honor Code is checked)
    console.log("[Submit] Step 1: Looking for primary quiz submit button with dynamic cds-<XYZ> class...");
    const firstSubmitBtn = await waitForFirstSubmitButton(token, 6000);

    if (firstSubmitBtn) {
        const cdsInfo = firstSubmitBtn._cdsClass || '(dynamic cds)';
        const xyzInfo = firstSubmitBtn._cdsXyz || 'N/A';
        console.log(`[Submit] Step 1: Clicking First Submit Button (${cdsInfo}, XYZ: ${xyzInfo}, data-testid='submit-button')...`, firstSubmitBtn);
        reliablyClickElement(firstSubmitBtn);
        // Wait brief delay (~500–1200 ms) for the "Ready to submit?" dialog to render
        await waitWithToken(800, token);
    } else {
        console.warn("[Submit] First submit button not found or already clicked, checking if modal is open...");
    }

    // 2. Locate Second Submit Button (Inside "Ready to submit?" Modal)
    console.log("[Submit] Step 2: Looking for confirmation submit button inside modal with dynamic cds-<XYZ> class...");
    await triggerModalSubmission(token, 6000);
}

function findMarkCompletedButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (/mark as complet|mark complet|i'm done|i am done/i.test(text)) {
            if (btn.offsetParent !== null && !btn.disabled) {
                return btn;
            }
        }
    }
    return null;
}

function isAssignmentAlreadyPassed() {
    const elements = Array.from(document.querySelectorAll('[data-testid*="grade" i], [data-testid*="status" i], .cds-badge, div, span'));
    for (const el of elements) {
        const text = (el.innerText || '').trim();
        if (/passed|completed|grade:\s*100%|your grade:\s*100%/i.test(text) && !/not passed/i.test(text)) {
            return true;
        }
    }
    return false;
}

// Dynamic Grade Result Detection: Waits until Coursera finishes grading and renders "Your grade:"
async function verifySubmissionSaved(token, timeoutMs = 75000) {
    const startTime = Date.now();
    let modalClickAttempts = 0;
    let modalStallCount = 0;

    console.log(`[Verify] Waiting for Coursera grading to finish and render 'Your grade:' (safety timeout: ${timeoutMs / 1000}s)...`);

    while (Date.now() - startTime < timeoutMs) {
        if (token && token !== activeExecutionToken) throw new Error("STALE_EXECUTION_TOKEN");

        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        // --- 1. ACTIVE MODAL CHECK & RETRY LOOP ---
        const activeModal = getActiveSubmissionModal();
        if (activeModal) {
            const modalText = (activeModal.innerText || '').toLowerCase();

            // Is the modal currently in flight ("Submitting...")?
            const isSubmitting = modalText.includes("submitting...") || 
                                 modalText.includes("submitting answers") || 
                                 activeModal.querySelector('.cds-spinner, [role="progressbar"]');
            if (isSubmitting) {
                updateWidgetStatus(`Submission in progress ('Submitting...')... ⏳ (${elapsedSec}s)`, "VERIFY_SAVED");
                console.log("[Verify] Modal is in submitting/spinner state, waiting...");
                await waitWithToken(1000, token);
                continue;
            }

            // Modal is sitting IDLE with an unclicked or unconsumed Submit button
            const modalSubmitBtn = getModalSubmitButton(activeModal);
            if (modalSubmitBtn) {
                modalStallCount++;
                // If modal stays open and idle for 2 ticks (~2 seconds), retry clicking it!
                if (modalStallCount >= 2 && modalClickAttempts < 3) {
                    modalClickAttempts++;
                    modalStallCount = 0;
                    const cdsInfo = modalSubmitBtn._cdsClass || '(dynamic cds)';
                    const xyzInfo = modalSubmitBtn._cdsXyz || 'N/A';
                    updateWidgetStatus(`Modal still open. Retrying Submit click (${modalClickAttempts}/3)... 🔄`, "VERIFY_SAVED");
                    console.log(`[Verify] Retrying modal submit click (attempt ${modalClickAttempts}/3 on ${cdsInfo}, XYZ: ${xyzInfo})...`, modalSubmitBtn);
                    reliablyClickElement(modalSubmitBtn);
                    await waitWithToken(1500, token);
                    continue;
                }
            } else {
                console.log("[Verify] Modal visible but submit button not found yet.");
            }

            // If we have retried 3 times and the modal is STILL open and idle:
            if (modalClickAttempts >= 3) {
                console.warn("[Verify] Modal remains open after 3 retry clicks.");
                return {
                    success: false,
                    reason: "MODAL_STUCK",
                    message: "The 'Ready to submit?' modal did not close. Please click Submit in the dialog."
                };
            }

            await waitWithToken(1000, token);
            continue; // Modal is still open, NEVER declare success while modal sits open!
        }

        // --- 2. MODAL CLOSED: POLL FOR 'Your grade:' & GRADED RESULT SCREEN ---
        updateWidgetStatus(`Submitting & waiting for 'Your grade:' result... ⏳ (${elapsedSec}s)`, "VERIFY_SAVED");

        const currentUrl = window.location.href;
        const bodyText = (document.body ? document.body.innerText : "");

        // Check A: Primary Signal - Visible text matching "Your grade: <percentage>%"
        const gradeMatch = bodyText.match(/Your grade:?\s*([0-9]+(?:\.[0-9]+)?%?)/i);
        if (gradeMatch) {
            const gradeText = gradeMatch[0].trim();
            console.log(`[Verify] Confirmed grade screen rendered: "${gradeText}" on ${currentUrl}`);
            return {
                success: true,
                reason: `Grade confirmed: ${gradeText}`,
                gradeText: gradeText
            };
        }

        // Check B: Dedicated Coursera Grade Elements
        const gradeSelectors = [
            '[data-testid="result-score"]',
            '[data-testid="grade-value"]',
            '[data-testid="GradeSummary"]',
            '[data-testid="AssignmentFeedbackBanner"]',
            '.rc-GradeSummary',
            '.rc-QuizFeedback',
            '.rc-GradeBar'
        ];
        for (const sel of gradeSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
                const elText = el.innerText.trim();
                if (elText) {
                    console.log(`[Verify] Confirmed grade element (${sel}): "${elText}"`);
                    return {
                        success: true,
                        reason: `Grade element found: ${elText.slice(0, 40)}`,
                        gradeText: elText
                    };
                }
            }
        }

        // Check C: /view-feedback or feedback URL with score summary indicators
        const isFeedbackUrl = /\/view-feedback/i.test(currentUrl) || currentUrl.includes("/feedback") || currentUrl.includes("/view-attempt");
        const hasLatest = /Your latest:?\s*[0-9]+(?:\.[0-9]+)?%?/i.test(bodyText);
        const hasHighest = /Your highest:?\s*[0-9]+(?:\.[0-9]+)?%?/i.test(bodyText);
        const hasPointBreakdown = /\d+\s*\/\s*\d+\s*points?/i.test(bodyText);
        const hasPassedCleanly = /passed/i.test(bodyText) && !/not passed/i.test(bodyText);

        if (isFeedbackUrl && (hasLatest || hasHighest || hasPointBreakdown || hasPassedCleanly)) {
            const snippet = hasLatest ? "Your latest score" : (hasHighest ? "Your highest score" : (hasPointBreakdown ? "Point breakdown" : "Passed"));
            console.log(`[Verify] Confirmed feedback view (${snippet}) on URL: ${currentUrl}`);
            return {
                success: true,
                reason: `Feedback confirmed (${snippet})`,
                gradeText: snippet
            };
        }

        // Check D: "Your latest:" or "Your highest:" anywhere in body text
        if (hasLatest || hasHighest) {
            const snippet = hasLatest ? "Your latest score" : "Your highest score";
            console.log(`[Verify] Confirmed score summary (${snippet})`);
            return {
                success: true,
                reason: `Score summary confirmed (${snippet})`,
                gradeText: snippet
            };
        }

        await waitWithToken(1000, token);
    }

    // Safety timeout exceeded without grade screen appearing
    console.warn(`[Verify] Safety timeout reached (${timeoutMs / 1000}s) without 'Your grade:' appearing.`);
    return {
        success: false,
        reason: "GRADE_TIMEOUT",
        message: `Grading timed out (${timeoutMs / 1000}s) without 'Your grade:' appearing. Paused to protect your progress.`
    };
}

// --- 7. Media and Non-Quiz Completion Via API ---
async function completeMediaChunked(itemsToComplete, courseSlug, authToken, userId, internalCourseId) {
    const CHUNK_SIZE = 6;
    const finalUserId = userId || "~";

    for (let i = 0; i < itemsToComplete.length; i += CHUNK_SIZE) {
        const chunk = itemsToComplete.slice(i, i + CHUNK_SIZE);
        const chunkPromises = chunk.map(async (item) => {
            try {
                if (item.type === 'lecture' || item.type === 'unknown') {
                    return fetch(`https://www.coursera.org/api/opencourse.v1/user/${finalUserId}/course/${courseSlug}/item/${item.id}/lecture/videoEvents/ended?autoEnroll=false`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "X-CSRF3-Token": authToken },
                        body: JSON.stringify({ "contentRequestBody": {} })
                    });
                } else {
                    if (internalCourseId) {
                        return fetch(`https://www.coursera.org/api/onDemandSupplementCompletions.v1`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "X-CSRF3-Token": authToken },
                            body: JSON.stringify({ "userId": parseInt(finalUserId) || finalUserId, "courseId": internalCourseId, "itemId": item.id })
                        });
                    }
                }
            } catch (e) {
                console.warn(`[Skip] Failed to complete item ${item.id}`, e);
            }
        });

        await Promise.all(chunkPromises);
        await wait(300);
    }
}

// Helper to extract course syllabus items in chronological order
function extractAllCourseMaterials(courseData) {
    const mediaItems = [];
    const assignmentItems = [];
    const itemMap = {};

    if (courseData && courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) {
        courseData.linked['onDemandCourseMaterialItems.v2'].forEach(item => {
            if (item && item.id) itemMap[item.id] = item;
        });
    }

    function processItem(item) {
        if (!item || !item.id) return;
        const exactType = (item.contentSummary && item.contentSummary.typeName) ? item.contentSummary.typeName : (item.itemClass || 'unknown');
        const name = item.name || '';
        const lowerName = name.toLowerCase();

        const isQuiz = ['quiz', 'exam'].includes(exactType) || lowerName.includes('quiz') || lowerName.includes('exam');
        const isLab = ['programming', 'workspace'].includes(exactType) || lowerName.includes('lab');
        const isAssignment = ['phasedPeer', 'peer', 'ungradedAssignment', 'staffGraded', 'ungradedWidget'].includes(exactType) || lowerName.includes('assignment') || lowerName.includes('challenge');

        if (isQuiz || isLab || isAssignment) {
            assignmentItems.push({
                id: item.id,
                name: name,
                type: exactType,
                isLocked: !!item.isLocked,
                isQuiz: isQuiz,
                isLab: isLab
            });
        } else {
            mediaItems.push({
                id: item.id,
                name: name,
                type: exactType
            });
        }
    }

    if (courseData && courseData.elements && courseData.elements[0] && courseData.elements[0].moduleIds && courseData.linked) {
        const modulesMap = {};
        (courseData.linked['onDemandCourseMaterialModules.v1'] || []).forEach(m => modulesMap[m.id] = m);

        const lessonsMap = {};
        (courseData.linked['onDemandCourseMaterialLessons.v1'] || []).forEach(l => lessonsMap[l.id] = l);

        courseData.elements[0].moduleIds.forEach(moduleId => {
            const mod = modulesMap[moduleId];
            if (mod && mod.lessonIds) {
                mod.lessonIds.forEach(lessonId => {
                    const lesson = lessonsMap[lessonId];
                    if (lesson && lesson.itemIds) {
                        lesson.itemIds.forEach(itemId => {
                            const it = itemMap[itemId];
                            if (it) processItem(it);
                        });
                    }
                });
            }
        });
    } else {
        Object.values(itemMap).forEach(processItem);
    }

    return { mediaItems, assignmentItems };
}

// --- 8. Explicit State Machine & Lifecycle Processor ---
async function startFullCourseSpeedrun() {
    const courseSlug = getCourseSlug();
    const authToken = getCsrfToken();
    const userId = getUserId();

    if (!courseSlug) {
        showOrUpdateBanner("Course not detected! Please open a Coursera course (/learn/...) page.", "error");
        setTimeout(hideBanner, 4000);
        return { error: "Course slug not detected" };
    }

    if (!authToken) {
        showOrUpdateBanner("Security token missing! Please refresh the Coursera page once to initialize.", "error");
        setTimeout(hideBanner, 4000);
        return { error: "Security token missing" };
    }

    showOrUpdateBanner("Gathering course syllabus structure... ⚡", "info");

    try {
        const courseDataUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds,optional),onDemandCourseMaterialLessons.v1(elementIds,optional,itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary,slug)`;
        const response = await fetch(courseDataUrl, {
            headers: { "X-CSRF3-Token": authToken }
        });

        if (!response.ok) {
            throw new Error(`Course materials API returned status ${response.status}`);
        }

        const courseData = await response.json();
        let internalCourseId = courseSlug;
        if (courseData.elements && courseData.elements[0] && courseData.elements[0].id) {
            internalCourseId = courseData.elements[0].id;
        }

        const { mediaItems, assignmentItems } = extractAllCourseMaterials(courseData);

        // Step 1: Complete all background videos and readings
        if (mediaItems.length > 0) {
            showOrUpdateBanner(`Completing all ${mediaItems.length} videos and readings in background...`, "info");
            await completeMediaChunked(mediaItems, courseSlug, authToken, userId, internalCourseId);
            showOrUpdateBanner(`All ${mediaItems.length} media items completed! ✅`, "success");
            await wait(1200);
        }

        if (assignmentItems.length === 0) {
            showOrUpdateBanner("🎉 Entire course completed! No assignments found.", "success");
            setTimeout(hideBanner, 6000);
            return { status: "complete" };
        }

        // Get Graded Assessment Handling Policy
        const settings = await chrome.storage.local.get(["gradedHandlingMode"]);
        const gradedMode = settings.gradedHandlingMode || "pause";

        const runnerState = {
            active: true,
            courseSlug: courseSlug,
            internalCourseId: internalCourseId,
            assignments: assignmentItems,
            currentIndex: 0,
            step: "DETECT_ITEM",
            statusText: "Starting assignment runner...",
            gradedHandlingMode: gradedMode
        };

        await chrome.storage.local.set({ speedrunRunnerState: runnerState });
        renderSpeedrunWidget(runnerState);

        // Begin navigation to first assignment
        navigateToAssignment(runnerState.assignments[0].id, courseSlug);
        return { status: "started" };

    } catch (err) {
        console.error("Speedrun initialization error:", err);
        showOrUpdateBanner("Speedrun error: " + err.message, "error");
        setTimeout(hideBanner, 6000);
        return { error: err.message };
    }
}

function stopSpeedrun() {
    activeExecutionToken = null;
    isNavigationInProgress = false;
    chrome.storage.local.remove(["speedrunRunnerState"], () => {
        hideSpeedrunWidget();
        showOrUpdateBanner("Speedrun stopped by user.", "info");
        setTimeout(hideBanner, 3000);
    });
}

function navigateToAssignment(itemId, courseSlug) {
    if (isNavigationInProgress) return;
    isNavigationInProgress = true;

    const targetUrl = `https://www.coursera.org/learn/${courseSlug}/item/${itemId}`;
    const link = document.querySelector(`a[href*="/item/${itemId}"]`);
    if (link) {
        link.click();
    } else {
        window.location.href = targetUrl;
    }
}

async function advanceToNextAssignment(state, reason = null) {
    if (isNavigationInProgress) return;

    state.currentIndex++;
    state.step = "ADVANCE_NEXT";

    if (state.currentIndex >= state.assignments.length) {
        state.active = false;
        await chrome.storage.local.remove(["speedrunRunnerState"]);
        hideSpeedrunWidget();
        showOrUpdateBanner("🎉 100% Course Complete! All videos, readings, quizzes and assignments finished! 🎓", "success");
        setTimeout(hideBanner, 8000);
        return;
    }

    const nextItem = state.assignments[state.currentIndex];
    state.statusText = `Moving to assignment ${state.currentIndex + 1} of ${state.assignments.length}...`;
    await chrome.storage.local.set({ speedrunRunnerState: state });
    renderSpeedrunWidget(state);

    await wait(1200);
    navigateToAssignment(nextItem.id, state.courseSlug);
}

// Primary Lifecycle State Machine Handler
async function processCurrentAssignmentStep() {
    const token = Date.now() + "_" + Math.random();
    activeExecutionToken = token;
    isNavigationInProgress = false;

    const data = await chrome.storage.local.get(["speedrunRunnerState", "aiProvider", "openRouterModel"]);
    const state = data.speedrunRunnerState;
    if (!state || !state.active) return;

    const currentItem = state.assignments[state.currentIndex];
    if (!currentItem) {
        state.active = false;
        await chrome.storage.local.remove(["speedrunRunnerState"]);
        hideSpeedrunWidget();
        return;
    }

    // Verify current URL matches assignment item ID
    const currentUrl = window.location.href;
    if (!currentUrl.includes(currentItem.id)) {
        state.step = "NAVIGATING";
        state.statusText = `Navigating to ${currentItem.name}...`;
        renderSpeedrunWidget(state);
        navigateToAssignment(currentItem.id, state.courseSlug);
        return;
    }

    renderSpeedrunWidget(state);

    try {
        // --- STEP 1: DETECT_ITEM ---
        state.step = "DETECT_ITEM";
        state.statusText = `Detecting item: ${currentItem.name}...`;
        renderSpeedrunWidget(state);
        await waitWithToken(1000, token);

        // Terminal Skip: Locked items
        if (currentItem.isLocked) {
            updateWidgetStatus(`Skipped: Assignment is locked by prerequisites. Moving on...`, "SKIPPED");
            await waitWithToken(2000, token);
            await advanceToNextAssignment(state, "Item is locked");
            return;
        }

        // Terminal Skip: Peer reviews
        if (['phasedPeer', 'peer', 'staffGraded'].includes(currentItem.type)) {
            updateWidgetStatus(`Skipped: Peer review requires evaluation by other learners. Moving on...`, "SKIPPED");
            await waitWithToken(2500, token);
            await advanceToNextAssignment(state, "Peer review item");
            return;
        }

        // --- STEP 2: WAIT_FOR_CONTENT_READY ---
        state.step = "WAIT_FOR_CONTENT_READY";
        state.statusText = "Waiting for page content & spinners to stabilize...";
        renderSpeedrunWidget(state);

        await waitForContentReady(token, 10000);

        // Check if already passed with 100% or passing grade
        if (isAssignmentAlreadyPassed()) {
            updateWidgetStatus("Already passed! Skipping... ✅", "VERIFY_SAVED");
            await waitWithToken(1500, token);
            await advanceToNextAssignment(state, "Already passed");
            return;
        }

        // Check if Ungraded reading/lab with "Mark as completed"
        const markDoneBtn = findMarkCompletedButton();
        if (markDoneBtn) {
            updateWidgetStatus("Marking completed... ✅", "SAVE_OR_SUBMIT");
            markDoneBtn.click();
            await waitWithToken(1500, token);
            await advanceToNextAssignment(state, "Marked completed");
            return;
        }

        // Check assessment categorization (Graded vs Practice)
        const assessType = detectAssessmentType(currentItem);
        const gradedMode = state.gradedHandlingMode || "pause";

        if (assessType.isGraded && gradedMode === "pause" && !authorizedGradedItemIds.has(currentItem.id)) {
            state.step = "PAUSED_GRADED";
            state.statusText = `Paused: Graded/Timed assessment detected (${assessType.reason}).`;
            await chrome.storage.local.set({ speedrunRunnerState: state });
            renderSpeedrunWidget(state);
            return; // Stay safely paused on this item until user clicks button
        }

        // Check for Start / Resume button on landing page
        const startBtn = findStartButton();
        if (startBtn) {
            updateWidgetStatus("Clicking Start Assignment... 🚀", "WAIT_FOR_CONTENT_READY");
            startBtn.click();
            await waitWithToken(3000, token);
            await waitForContentReady(token, 8000);
        }

        // --- STEP 3: SOLVE_OR_HANDLE ---
        state.step = "SOLVE_OR_HANDLE";
        const questions = scrapeAssessment();

        if (questions.length === 0) {
            // No questions found (might be external tool or reading)
            updateWidgetStatus("No questions detected on this item. Advancing to next...", "SKIPPED");
            await waitWithToken(2000, token);
            await advanceToNextAssignment(state, "No questions found");
            return;
        }

        const provider = (data.aiProvider || "gemini").toLowerCase();
        const modelName = provider === "openrouter" ? (data.openRouterModel || "openrouter/auto") : "Gemini";
        state.statusText = `Solving ${questions.length} questions with ${provider === "openrouter" ? "OpenRouter" : "Gemini"} (${modelName})... 🤖`;
        renderSpeedrunWidget(state);

        chrome.runtime.sendMessage(
            { action: "fetchAIExplanation", text: questions },
            async (aiResponse) => {
                if (token !== activeExecutionToken) return;

                if (aiResponse && aiResponse.error) {
                    state.step = "PAUSED_ERROR";
                    state.lastErrorMessage = aiResponse.error;
                    state.statusText = `Paused: ${aiResponse.error}`;
                    await chrome.storage.local.set({ speedrunRunnerState: state });
                    renderSpeedrunWidget(state);
                    return; // Pause runner, do NOT skip item
                }

                if (aiResponse && aiResponse.result) {
                    // --- STEP 4: SAVE_OR_SUBMIT ---
                    state.step = "SAVE_OR_SUBMIT";
                    state.statusText = "Applying AI answers to page... ✍️";
                    renderSpeedrunWidget(state);

                    applyAnswersToDOM(aiResponse.result);
                    await waitWithToken(1000, token);

                    state.statusText = "Agreeing to Honor Code & Signing... 📝";
                    renderSpeedrunWidget(state);
                    findAndCheckHonorCode();
                    await waitWithToken(1200, token);

                    state.statusText = "Submitting answers (Step 1: Submit, Step 2: Confirm)... 🚀";
                    renderSpeedrunWidget(state);

                    await executeTwoStepQuizSubmission(token);

                    // --- STEP 5: VERIFY_SAVED ---
                    state.step = "VERIFY_SAVED";
                    state.statusText = "Submitting & waiting for 'Your grade:' result... ⏳";
                    renderSpeedrunWidget(state);

                    const verifyResult = await verifySubmissionSaved(token, 75000);

                    if (!verifyResult.success) {
                        state.step = "PAUSED_SUBMISSION";
                        state.lastErrorMessage = verifyResult.message || "Submission confirmation failed";
                        state.statusText = `Paused: ${state.lastErrorMessage}`;
                        await chrome.storage.local.set({ speedrunRunnerState: state });
                        renderSpeedrunWidget(state);
                        return; // PAUSE! Do not advance when submission unconfirmed!
                    }

                    state.statusText = `Submission verified & graded (${verifyResult.gradeText || "Saved"})! ✅`;
                    renderSpeedrunWidget(state);
                    await waitWithToken(1500, token);

                    // --- STEP 6: ADVANCE_NEXT ---
                    await advanceToNextAssignment(state);
                } else {
                    state.step = "PAUSED_ERROR";
                    state.lastErrorMessage = "No answers returned by AI";
                    state.statusText = "Paused: No answers returned by AI";
                    await chrome.storage.local.set({ speedrunRunnerState: state });
                    renderSpeedrunWidget(state);
                }
            }
        );

    } catch (err) {
        if (err.message === "STALE_EXECUTION_TOKEN") {
            console.log("[Lifecycle] Execution canceled due to stale token / navigation.");
            return;
        }
        console.error("[Lifecycle Error]:", err);
        state.step = "PAUSED_ERROR";
        state.lastErrorMessage = err.message;
        state.statusText = `Error: ${err.message}`;
        await chrome.storage.local.set({ speedrunRunnerState: state });
        renderSpeedrunWidget(state);
    }
}

// --- 9. Single Quiz Auto-Solve & Submit (Direct Action) ---
async function solveAndSubmitCurrentQuiz() {
    const token = Date.now() + "_single";
    activeExecutionToken = token;
    showOrUpdateBanner("Starting Single Quiz Solver... 🤖", "info");

    const startBtn = findStartButton();
    if (startBtn) {
        showOrUpdateBanner("Launching assignment... 🚀", "info");
        startBtn.click();
        await wait(3000);
    }

    await waitForContentReady(token, 6000);

    let questions = scrapeAssessment();
    if (questions.length === 0) {
        showOrUpdateBanner("No questions found on this page! Make sure you are on a quiz.", "error");
        setTimeout(hideBanner, 4000);
        return { error: "No questions found" };
    }

    const data = await chrome.storage.local.get(["aiProvider", "openRouterModel"]);
    const provider = (data.aiProvider || "gemini").toLowerCase();
    const model = provider === "openrouter" ? (data.openRouterModel || "openrouter/auto") : "Gemini";

    showOrUpdateBanner(`Solving ${questions.length} questions with ${provider === "openrouter" ? "OpenRouter" : "Gemini"}... 🤖`, "info");

    chrome.runtime.sendMessage(
        { action: "fetchAIExplanation", text: questions },
        async (aiResponse) => {
            if (aiResponse && aiResponse.error) {
                showOrUpdateBanner("AI Error: " + aiResponse.error, "error");
                setTimeout(hideBanner, 6000);
                return;
            }

            if (aiResponse && aiResponse.result) {
                showOrUpdateBanner("Applying answers... ✍️", "info");
                applyAnswersToDOM(aiResponse.result);
                await wait(1000);

                showOrUpdateBanner("Agreeing to Honor Code... 📝", "info");
                findAndCheckHonorCode();
                await wait(1200);

                showOrUpdateBanner("Submitting quiz (Step 1: Submit, Step 2: Confirm)... 🚀", "info");
                await executeTwoStepQuizSubmission(token);

                showOrUpdateBanner("Submitting & waiting for 'Your grade:' result... ⏳", "info");
                const verifyResult = await verifySubmissionSaved(token, 75000);
                if (verifyResult.success) {
                    showOrUpdateBanner(`Quiz submitted & graded (${verifyResult.gradeText || "Confirmed"})! ✅`, "success");
                    setTimeout(hideBanner, 6000);
                } else {
                    showOrUpdateBanner("⚠️ " + verifyResult.message, "error");
                }
            }
        }
    );

    return { status: "started" };
}

// --- 10. Message Handling from Extension Popup ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startSpeedrunAll") {
        startFullCourseSpeedrun().then(res => sendResponse(res));
        return true;
    }

    if (request.action === "stopSpeedrun") {
        stopSpeedrun();
        sendResponse({ status: "stopped" });
        return true;
    }

    if (request.action === "solveAndSubmitCurrent") {
        solveAndSubmitCurrentQuiz().then(res => sendResponse(res));
        return true;
    }

    if (request.action === "solveQuizDirectly") {
        showOrUpdateBanner("Extracting questions and contacting AI... 🤖", "info");
        const arrayQuestions = scrapeAssessment();

        if (!arrayQuestions || arrayQuestions.length === 0) {
            showOrUpdateBanner("No questions found on this page! Are you on a quiz?", "error");
            setTimeout(hideBanner, 4000);
            sendResponse({ error: "No questions found" });
            return true;
        }

        chrome.runtime.sendMessage(
            { action: "fetchAIExplanation", text: arrayQuestions },
            (aiResponse) => {
                if (aiResponse && aiResponse.error) {
                    showOrUpdateBanner("Error: " + aiResponse.error, "error");
                    setTimeout(hideBanner, 5000);
                } else if (aiResponse && aiResponse.result) {
                    applyAnswersToDOM(aiResponse.result);
                    findAndCheckHonorCode();
                    showOrUpdateBanner("Answers applied successfully! ✅", "success");
                    setTimeout(hideBanner, 4000);
                }
            }
        );
        sendResponse({ status: "started" });
        return true;
    }

    if (request.action === "completeVideos") {
        const courseSlug = getCourseSlug();
        const authToken = getCsrfToken();
        const userId = getUserId();

        if (!authToken) {
            sendResponse({ error: "Missing Auth Token! Please refresh the page to grab security tokens." });
            return true;
        }
        if (!courseSlug) {
            sendResponse({ error: "Missing Course ID! Please navigate to a course inside /learn/." });
            return true;
        }

        sendResponse({ status: "started" });
        showOrUpdateBanner("Completing videos & reading materials... ⚡", "info");

        const courseDataUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds,optional),onDemandCourseMaterialLessons.v1(elementIds,optional,itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`;
        fetch(courseDataUrl, { headers: { "X-CSRF3-Token": authToken } })
            .then(r => r.json())
            .then(async (data) => {
                let internalCourseId = courseSlug;
                if (data.elements && data.elements[0] && data.elements[0].id) {
                    internalCourseId = data.elements[0].id;
                }
                const { mediaItems } = extractAllCourseMaterials(data);
                await completeMediaChunked(mediaItems, courseSlug, authToken, userId, internalCourseId);
                showOrUpdateBanner("Videos and readings completed! Please refresh the page.", "success");
                setTimeout(hideBanner, 6000);
            })
            .catch(err => {
                showOrUpdateBanner("Error completing materials: " + err.message, "error");
                setTimeout(hideBanner, 5000);
            });
        return true;
    }

    if (request.action === "getSelection") {
        const arrayQuestions = scrapeAssessment();
        sendResponse({ data: arrayQuestions });
        return true;
    }

    if (request.action === "applyAIResponse") {
        applyAnswersToDOM(request.data);
        sendResponse({ status: "applied" });
        return true;
    }

    if (request.action === "getSpeedrunStatus") {
        chrome.storage.local.get(["speedrunRunnerState"], (res) => {
            sendResponse(res.speedrunRunnerState || null);
        });
        return true;
    }

    return true;
});

// --- 11. SPA Route Listener & Auto-Resume ---
window.addEventListener("load", () => {
    setTimeout(processCurrentAssignmentStep, 1500);
});

let lastUrl = window.location.href;
const routeObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        activeExecutionToken = null; // Invalidate any running operations from previous page
        isNavigationInProgress = false;
        setTimeout(processCurrentAssignmentStep, 1500);
    }
});
routeObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", () => {
    activeExecutionToken = null;
    isNavigationInProgress = false;
    setTimeout(processCurrentAssignmentStep, 1500);
});

// Initial boot check
setTimeout(processCurrentAssignmentStep, 1200);
