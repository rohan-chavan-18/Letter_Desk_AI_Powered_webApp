exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  // Lightweight health check. It never exposes the API key.
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        function: "generate-letter",
        geminiKeyConfigured: Boolean(process.env.ROHAN_SECURE_GEMINI_KEY)
      })
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    let data = {};
    try {
      data = event.body ? JSON.parse(event.body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Invalid JSON request body." })
      };
    }

    const API_KEY = process.env.ROHAN_SECURE_GEMINI_KEY;
    if (!API_KEY || !API_KEY.trim()) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Gemini API key is not available to this Netlify Function. Confirm ROHAN_SECURE_GEMINI_KEY has the Functions scope and redeploy the site."
        })
      };
    }

    const systemInstruction = {
      parts: [{
        text: [
          "You are Letter Desk's student administrative letter-writing assistant.",
          "Write polished, natural, ready-to-send student letters in a formal and respectful tone.",
          "Preserve every fact the student supplied and never invent dates, medical reasons, addresses, events, permissions, documents, or other specific facts.",
          "If the student's situation is very short or vague, make the writing more descriptive by expanding the request with general, non-factual administrative language: explain the request clearly, state its practical purpose in neutral terms, and add a courteous request for consideration. Do not fabricate a reason.",
          "Use 2 to 4 coherent body paragraphs when appropriate. Avoid repetitive filler and overly ornate language.",
          "Return ONLY the complete letter text. Do not add explanations, analysis, markdown fences, or commentary."
        ].join(" ")
      }]
    };

    let contents;

    if (Array.isArray(data.messages) && data.messages.length) {
      const rawContents = data.messages
        .filter((message) => message && typeof message.content === "string" && message.content.trim())
        .map((message) => ({
          role: message.role === "assistant" || message.role === "model" ? "model" : "user",
          parts: [{ text: message.content.trim() }]
        }));

      // Gemini conversation content must begin with a user turn.
      if (!rawContents.length || rawContents[0].role !== "user") {
        rawContents.unshift({
          role: "user",
          parts: [{ text: "Write a complete, ready-to-send formal student administrative letter." }]
        });
      }

      // Keep the conversation valid and compact if the frontend ever sends
      // consecutive turns with the same role.
      contents = [];
      for (const item of rawContents) {
        const previous = contents[contents.length - 1];
        if (previous && previous.role === item.role) {
          previous.parts.push(...item.parts);
        } else {
          contents.push(item);
        }
      }
    } else {
      const {
        letterType = "",
        recipient = "",
        content = "",
        studentName = "",
        rollNo = "",
        institution = "",
        through = "",
        tone = "Formal and respectful",
        language = "English"
      } = data;

      const promptText = [
        "Create the complete final student administrative letter using these details:",
        `Type of Letter: ${letterType}`,
        `Intended Recipient: ${recipient}`,
        `Student Sender Identity: ${studentName} (Roll/Class ID: ${rollNo})`,
        `Institution Environment: ${institution}`,
        `Routing Layer: ${through ? `Through: ${through}` : "None"}`,
        `Requested Tone: ${tone}`,
        `Target Language: ${language}`,
        `Student's situation: ${content}`,
        "Use a clean structure with Date, To, Through if supplied, Subject, Salutation, 2-4 body paragraphs, and sign-off.",
        "Do not invent facts. Use a short bracketed placeholder for a genuinely required missing detail."
      ].join("\n");

      contents = [{ role: "user", parts: [{ text: promptText }] }];
    }

    if (!contents.length) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "No drafting content was supplied." })
      };
    }

    // Gemini can temporarily return 503 when a model is overloaded.
    // Retry the primary model briefly, then fall back to a lighter stable model.
    const primaryModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const fallbackModels = [primaryModel, "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
      .filter((model, index, arr) => model && arr.indexOf(model) === index);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let result = {};
    let lastStatus = 500;
    let lastMessage = "Gemini API request failed.";
    let successfulModel = null;

    for (let modelIndex = 0; modelIndex < fallbackModels.length; modelIndex++) {
      const model = fallbackModels[modelIndex];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const maxAttempts = modelIndex === 0 ? 3 : 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY.trim()
          },
          body: JSON.stringify({
            systemInstruction,
            contents,
            generationConfig: {
              maxOutputTokens: 1800
            }
          })
        });

        const responseText = await response.text();
        try {
          result = responseText ? JSON.parse(responseText) : {};
        } catch {
          result = {};
        }

        if (response.ok) {
          successfulModel = model;
          break;
        }

        lastStatus = response.status;
        lastMessage = result?.error?.message || responseText || `Gemini API request failed with status ${response.status}.`;

        // 503 means temporary service overload. Retry with exponential backoff.
        // 429 is also transient; retry it before trying the fallback model.
        const retryable = response.status === 503 || response.status === 429 || response.status === 408 || response.status === 500 || response.status === 502 || response.status === 504;
        if (!retryable) break;
        if (attempt < maxAttempts) {
          await sleep(modelIndex === 0 ? attempt * 2500 : attempt * 1500);
        }
      }

      if (successfulModel) break;

      // Do not waste time trying fallback models for authentication, bad request,
      // or permission errors. Those need a key/project/configuration fix.
      if (![408, 429, 500, 502, 503, 504].includes(lastStatus)) break;
    }

    if (!successfulModel) {
      const err = new Error(lastMessage);
      err.statusCode = lastStatus === 429 || lastStatus === 503 ? lastStatus : 502;
      err.upstreamStatus = lastStatus;
      throw err;
    }

    const generatedText = result?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim();

    if (!generatedText) {
      const reason = result?.promptFeedback?.blockReason;
      throw new Error(reason
        ? `Gemini blocked the request: ${reason}.`
        : "Gemini returned no letter text.");
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        letter: generatedText,
        text: generatedText
      })
    };
  } catch (error) {
    const statusCode =
      Number.isInteger(error?.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;

    return {
      statusCode,
      headers: corsHeaders,
      body: JSON.stringify({
        error: error?.message || "Failed API processing call.",
        ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {})
      })
    };
  }
};
