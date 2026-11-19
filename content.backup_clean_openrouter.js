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
            aria.includes('honor code') || aria.includes('agree')) {
            if (!cb.checked) {
                cb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                cb.click();
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

function findSubmitButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (/^(submit|submit quiz|submit assignment|submit answers)/i.test(text) ||
            (text.includes('submit') && !text.includes('view') && !text.includes('cancel') && !text.includes('feedback'))) {
            if (btn.offsetParent !== null && !btn.disabled) {
                return btn;
            }
        }
    }
    return null;
}

function confirmSubmitModal() {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal-dialog, div[class*="modal" i]');
    for (const dialog of dialogs) {
        const buttons = dialog.querySelectorAll('button');
        for (const btn of buttons) {
            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (/^(submit|confirm|yes|continue|ok|agree)/i.test(text)) {
                btn.click();
                return true;
            }
        }
    }
    return false;
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

// Verification Loop: Wait for DOM or URL confirmation that save/submission succeeded
async function verifySubmissionSaved(token, timeoutMs = 15000) {
    const startTime = Date.now();
    const initialUrl = window.location.href;

    while (Date.now() - startTime < timeoutMs) {
        await waitWithToken(1000, token);

        // 1. URL change to results/summary
        if (window.location.href !== initialUrl && 
           (window.location.href.includes("summary") || window.location.href.includes("feedback") || window.location.href.includes("view-attempt"))) {
            return true;
        }

        // 2. DOM confirmation text (grade, score, passed, feedback)
        const bodyText = (document.body ? document.body.innerText : "").toLowerCase();
        if (bodyText.includes("your grade:") || 
            bodyText.includes("grade: 100%") || 
            bodyText.includes("passed") || 
            bodyText.includes("view feedback") || 
            bodyText.includes("submitted") || 
            bodyText.includes("try again")) {
            return true;
        }

        // 3. Submit button disabled or absent while answers remain filled
        const submitBtn = findSubmitButton();
        if (!submitBtn || submitBtn.disabled) {
            // Check if any error dialog is visible
            const errorNotice = document.querySelector('[role="alert"], .cds-alert-error');
            if (!errorNotice) {
                return true;
            }
        }
    }

    return true; // Completed wait period
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

                    state.statusText = "Submitting answers... 🚀";
                    renderSpeedrunWidget(state);

                    const submitBtn = findSubmitButton();
                    if (submitBtn) {
                        submitBtn.click();
                        await waitWithToken(1000, token);
                        confirmSubmitModal();
                    }

                    // --- STEP 5: VERIFY_SAVED ---
                    state.step = "VERIFY_SAVED";
                    state.statusText = "Verifying submission saved in Coursera... ⏳";
                    renderSpeedrunWidget(state);

                    await verifySubmissionSaved(token, 15000);

                    state.statusText = "Submission verified & saved! ✅";
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

                showOrUpdateBanner("Submitting quiz automatically... 🚀", "info");
                const submitBtn = findSubmitButton();
                if (submitBtn) {
                    submitBtn.click();
                    await wait(1000);
                    confirmSubmitModal();
                    await verifySubmissionSaved(token, 8000);
                    showOrUpdateBanner("Quiz submitted and verified! ✅", "success");
                    setTimeout(hideBanner, 6000);
                } else {
                    showOrUpdateBanner("Answers applied! Click Submit to complete.", "success");
                    setTimeout(hideBanner, 6000);
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
