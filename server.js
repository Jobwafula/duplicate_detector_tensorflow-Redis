const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const stringSimilarity = require("string-similarity");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const { v4: uuidv4 } = require("uuid");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Bottleneck = require("bottleneck");
const { jsonrepair } = require("jsonrepair");

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const MAX_QUESTIONS_PER_BATCH = 1000;
const SIMILARITY_THRESHOLD = 0.85;
const PREFILTER_THRESHOLD = 0.6;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, "Uploads");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyAO33YpeMHGd49SZGmwnmS4pu3lRCpv7eE";
const GEMINI_MODEL_NAME = "gemini-1.5-flash";
const GEMINI_REQUESTS_PER_MINUTE = 15;
const GEMINI_BATCH_SIZE = 5;
const MAX_RETRIES = 3;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });

// Rate limiter for Gemini API
const limiter = new Bottleneck({
  reservoir: GEMINI_REQUESTS_PER_MINUTE,
  reservoirRefreshAmount: GEMINI_REQUESTS_PER_MINUTE,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 2,
});

// Track API usage
let apiCallCount = 0;
let apiFailures = 0;
let fallbackCount = 0;

// Similarity cache
const similarityCache = new Map();

// Ensure uploads directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

// JSON file path
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// Multer configuration for file uploads
const upload = multer({
  dest: UPLOADS_DIR,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files are allowed (.xls, .xlsx)"));
    }
  },
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// Initialize JSON file and test API key
async function initialize() {
  try {
    await fs.access(QUESTIONS_FILE);
  } catch {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions: [] }));
  }

  // Test API key
  try {
    const result = await model.generateContent("Test API connectivity");
    console.log("Gemini API test successful:", await result.response.text());
  } catch (e) {
    console.error("Gemini API key validation failed:", e.message);
  }

  console.log("System ready with Gemini integration!");
}

// Enhanced JSON sanitization
function sanitizeJsonString(jsonString) {
  try {
    // Remove Markdown code fences
    jsonString = jsonString.replace(/```json\n|```/g, '');
    // Remove extra commas before closing brackets/braces
    jsonString = jsonString.replace(/,\s*([\]}])/g, '$1');
    // Remove trailing commas
    jsonString = jsonString.replace(/,(\s*[\]}])/g, '$1');
    // Replace single quotes with double quotes for keys and values
    jsonString = jsonString.replace(/(\w+|'[^']+')(?=\s*:)/g, (match) => `"${match.replace(/'/g, '')}"`);
    jsonString = jsonString.replace(/:(\s*)'([^']+)'/g, ':$1"$2"');
    // Escape unescaped quotes within strings
    jsonString = jsonString.replace(/(?<!\\)(\")(?=.*\":)/g, '\\$1');
    // Remove invalid characters
    jsonString = jsonString.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    // Fix missing closing braces/brackets
    let openBraces = (jsonString.match(/{/g) || []).length;
    let closeBraces = (jsonString.match(/}/g) || []).length;
    while (openBraces > closeBraces) {
      jsonString += '}';
      closeBraces++;
    }
    let openBrackets = (jsonString.match(/\[/g) || []).length;
    let closeBrackets = (jsonString.match(/]/g) || []).length;
    while (openBrackets > closeBrackets) {
      jsonString += ']';
      closeBrackets++;
    }
    // Remove extra text before/after JSON
    jsonString = jsonString.replace(/^[\s\S]*?({[\s\S]*?})[\s\S]*?$/, '$1');
    return jsonString;
  } catch (e) {
    console.error("JSON sanitization failed:", e.message);
    return jsonString;
  }
}

// Enhanced similarity check with robust JSON handling
async function checkSimilarity(question1, question2, retryCount = 0) {
  const cacheKey = `${question1}||${question2}`.toLowerCase();
  if (similarityCache.has(cacheKey)) {
    console.log(`Cache hit for ${cacheKey}`);
    return similarityCache.get(cacheKey);
  }

  // Pre-filter with string similarity
  const quickSimilarity = stringSimilarity.compareTwoStrings(
    question1.toLowerCase(),
    question2.toLowerCase()
  );
  if (quickSimilarity < PREFILTER_THRESHOLD) {
    const result = {
      similarityScore: quickSimilarity,
      isSameQuestion: false,
      reasons: ["Low lexical similarity"],
      analysis: "Questions are lexically distinct based on quick comparison"
    };
    similarityCache.set(cacheKey, result);
    return result;
  }

  try {
    const result = await limiter.schedule(async () => {
      apiCallCount++;
      console.log(`Gemini API call #${apiCallCount} for "${question1}" vs "${question2}"`);
      
      const prompt = `Return only a raw JSON object (no Markdown, no code fences) analyzing the similarity between:
      Question 1: "${question1}"
      Question 2: "${question2}"
      Format:
      {
        "similarityScore": number,
        "isSameQuestion": boolean,
        "reasons": string[],
        "analysis": string
      }
      Ensure all strings are properly escaped and the response is valid JSON.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();
      console.log(`Gemini raw response: ${text}`);
      
      // Extract JSON
      let jsonString = text;
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}') + 1;
      if (jsonStart !== -1 && jsonEnd !== 0) {
        jsonString = text.slice(jsonStart, jsonEnd);
      } else {
        console.warn("No JSON delimiters found, attempting to parse entire response");
      }

      // Sanitize JSON
      jsonString = sanitizeJsonString(jsonString);
      console.log(`Sanitized JSON: ${jsonString}`);

      try {
        // Attempt JSON repair
        jsonString = jsonrepair(jsonString);
        const analysis = JSON.parse(jsonString);
        const result = {
          similarityScore: analysis.similarityScore || quickSimilarity,
          isSameQuestion: analysis.isSameQuestion || quickSimilarity > SIMILARITY_THRESHOLD,
          reasons: analysis.reasons || ["Based on Gemini analysis"],
          analysis: analysis.analysis || "Gemini analysis completed"
        };
        similarityCache.set(cacheKey, result);
        return result;
      } catch (e) {
        console.error(`Failed to parse Gemini response for questions: "${question1}" vs "${question2}"`);
        console.error("Raw response:", text);
        console.error("Sanitized JSON:", jsonString);
        console.error("Parse error:", e.message, e.stack);
        throw new Error("Invalid JSON response from Gemini");
      }
    });

    return result;
  } catch (error) {
    apiFailures++;
    console.error(`Gemini API error for "${question1}" vs "${question2}":`, {
      message: error.message,
      status: error.status,
      stack: error.stack
    });

    if (error.status === 429 && retryCount < MAX_RETRIES) {
      const delayMs = 10000 * Math.pow(2, retryCount);
      console.warn(`Rate limit hit, retrying after ${delayMs / 1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return checkSimilarity(question1, question2, retryCount + 1);
    }

    // Retry with simplified prompt for JSON parsing errors
    if (error.message.includes("Invalid JSON") && retryCount < MAX_RETRIES) {
      console.warn(`Retrying with simplified prompt due to JSON error (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      const simplifiedPrompt = `Return only a raw JSON object (no Markdown, no code fences):
      {
        "similarityScore": ${quickSimilarity.toFixed(2)},
        "isSameQuestion": ${quickSimilarity > SIMILARITY_THRESHOLD},
        "reasons": ["Based on initial similarity check"],
        "analysis": "Simplified response due to previous JSON parsing failure"
      }`;
      try {
        const result = await limiter.schedule(async () => {
          apiCallCount++;
          console.log(`Gemini API retry call #${apiCallCount} for simplified prompt`);
          const result = await model.generateContent(simplifiedPrompt);
          let text = (await result.response.text()).trim();
          console.log(`Gemini retry response: ${text}`);
          // Remove Markdown code fences
          text = text.replace(/```json\n|```/g, '');
          const jsonString = sanitizeJsonString(text);
          console.log(`Sanitized retry JSON: ${jsonString}`);
          const analysis = JSON.parse(jsonrepair(jsonString));
          const resultData = {
            similarityScore: analysis.similarityScore || quickSimilarity,
            isSameQuestion: analysis.isSameQuestion || quickSimilarity > SIMILARITY_THRESHOLD,
            reasons: analysis.reasons || ["Based on initial similarity check"],
            analysis: analysis.analysis || "Simplified response due to previous JSON parsing failure"
          };
          similarityCache.set(cacheKey, resultData);
          return resultData;
        });
        return result;
      } catch (retryError) {
        console.error("Retry with simplified prompt failed:", retryError.message, retryError.stack);
      }
    }

    // Fallback to quick similarity for near-identical questions
    if (quickSimilarity >= 0.95) {
      console.warn("Using quick similarity due to repeated JSON parsing failures");
      const result = {
        similarityScore: quickSimilarity,
        isSameQuestion: quickSimilarity > SIMILARITY_THRESHOLD,
        reasons: ["High lexical similarity detected"],
        analysis: "Gemini analysis failed: Repeated JSON parsing errors - used quick similarity"
      };
      similarityCache.set(cacheKey, result);
      return result;
    }

    fallbackCount++;
    console.warn("Falling back to string similarity");
    const words1 = question1.toLowerCase().split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
    const words2 = question2.toLowerCase().split(/\s+/).map(w => w.replace(/[^\w]/g, ''));
    const commonWords = words1.filter(w => w.includes(w) && w.length > 2);
    const result = {
      similarityScore: quickSimilarity,
      isSameQuestion: quickSimilarity > SIMILARITY_THRESHOLD,
      reasons: commonWords.length > 0 
        ? [{ type: "common_words", words: commonWords, count: commonWords.length }]
        : ["Fallback to string similarity due to API error"],
      analysis: `Gemini analysis failed: ${error.message} - used basic string comparison`
    };
    similarityCache.set(cacheKey, result);
    return result;
  }
}

// Read questions from JSON file
async function getStoredQuestions() {
  try {
    const data = await fs.readFile(QUESTIONS_FILE, "utf8");
    return JSON.parse(data).questions || [];
  } catch (err) {
    console.error("Error reading questions file:", err);
    return [];
  }
}

// Write questions to JSON file
async function saveQuestions(questions) {
  try {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions }, null, 2));
  } catch (err) {
    console.error("Error writing questions file:", err);
  }
}

// Process multiple questions with Gemini similarity checking
async function processQuestions(questions, rowData = []) {
  if (!Array.isArray(questions)) {
    throw new Error("Input must be an array of questions");
  }

  const validQuestions = questions
    .filter((q) => typeof q === "string" && q.trim().length > 0);

  if (validQuestions.length === 0) {
    throw new Error("No valid questions provided");
  }

  console.log(`Processing ${validQuestions.length} questions...`);
  const results = [];
  const newQuestions = [];
  const existingQuestions = await getStoredQuestions();

  // Pre-filter existing questions with quick similarity
  const prefilteredExisting = await Promise.all(
    validQuestions.map(async (q) => {
      const candidates = existingQuestions.map((eq) => ({
        text: eq.text,
        quickScore: stringSimilarity.compareTwoStrings(
          q.toLowerCase(),
          eq.text.toLowerCase()
        )
      }));
      return candidates
        .filter(c => c.quickScore >= PREFILTER_THRESHOLD)
        .map(c => c.text);
    })
  );

  for (let i = 0; i < validQuestions.length; i += GEMINI_BATCH_SIZE) {
    const batchQuestions = validQuestions.slice(i, i + GEMINI_BATCH_SIZE);
    const batchRowData = rowData.slice(i, i + GEMINI_BATCH_SIZE);
    const batchPrefiltered = prefilteredExisting.slice(i, i + GEMINI_BATCH_SIZE);

    console.log(`Processing batch ${i / GEMINI_BATCH_SIZE + 1} of ${Math.ceil(validQuestions.length / GEMINI_BATCH_SIZE)}`);

    for (let j = 0; j < batchQuestions.length; j++) {
      const currentQuestion = batchQuestions[j];
      let isDuplicate = false;
      let mostSimilar = { 
        similarity: 0, 
        question: "", 
        explanation: [],
        analysis: ""
      };

      // Check against pre-filtered existing questions
      const candidates = batchPrefiltered[j];
      for (const existingText of candidates) {
        const existing = existingQuestions.find(eq => eq.text === existingText);
        if (!existing) continue;

        const { similarityScore, isSameQuestion, reasons, analysis } = 
          await checkSimilarity(currentQuestion, existing.text);
        
        if (similarityScore > mostSimilar.similarity) {
          mostSimilar = {
            similarity: similarityScore,
            question: existing.text,
            explanation: reasons,
            analysis: analysis
          };
        }

        if (isSameQuestion || similarityScore > SIMILARITY_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      }

      // Check against previous unique questions in this batch
      if (!isDuplicate) {
        for (const newQ of newQuestions) {
          if (newQ.isUnique) {
            const quickSimilarity = stringSimilarity.compareTwoStrings(
              currentQuestion.toLowerCase(),
              newQ.text.toLowerCase()
            );
            if (quickSimilarity < PREFILTER_THRESHOLD) continue;

            const { similarityScore, isSameQuestion, reasons, analysis } = 
              await checkSimilarity(currentQuestion, newQ.text);
            
            if (similarityScore > mostSimilar.similarity) {
              mostSimilar = {
                similarity: similarityScore,
                question: newQ.text,
                explanation: reasons,
                analysis: analysis
              };
            }

            if (isSameQuestion || similarityScore > SIMILARITY_THRESHOLD) {
              isDuplicate = true;
              break;
            }
          }
        }
      }

      results.push({
        question: currentQuestion,
        isDuplicate,
        mostSimilarQuestion: mostSimilar.similarity > 0.6 ? mostSimilar.question : null,
        similarityScore: mostSimilar.similarity,
        similarityExplanation: mostSimilar.explanation,
        semanticAnalysis: mostSimilar.analysis,
        rowData: batchRowData[j] || {}
      });

      if (!isDuplicate) {
        newQuestions.push({
          id: `question-${uuidv4()}`,
          text: currentQuestion,
          createdAt: new Date().toISOString(),
          isUnique: true
        });
      }
    }
  }

  console.log(`Finished processing. Saving ${newQuestions.length} new questions.`);
  if (newQuestions.length > 0) {
    const updatedQuestions = [...existingQuestions, ...newQuestions];
    await saveQuestions(updatedQuestions);
  }

  return results;
}

// Process Excel file
async function processExcelFile(filePath) {
  try {
    console.log(`Processing Excel file: ${filePath}`);
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: "A", defval: "" });

    if (data.length === 0) {
      throw new Error("Excel file is empty");
    }

    const questionColumnNames = ['question', 'question text', 'q', 'text', 'questions'];
    let questionColumn = null;
    
    const firstRow = data[0];
    for (const [key, value] of Object.entries(firstRow)) {
      if (questionColumnNames.includes(String(value).toLowerCase().trim())) {
        questionColumn = key;
        break;
      }
    }

    if (!questionColumn) {
      throw new Error("No question column found in the Excel file");
    }

    const questions = [];
    const rowData = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const question = row[questionColumn];
      if (typeof question === "string" && question.trim().length > 0) {
        questions.push(question.trim());
        rowData.push(row);
      }
    }

    if (questions.length === 0) {
      throw new Error("No valid questions found in the Excel file");
    }

    let results;
    if (questions.length > MAX_QUESTIONS_PER_BATCH) {
      const batchResults = [];
      for (let i = 0; i < questions.length; i += MAX_QUESTIONS_PER_BATCH) {
        const batchQuestions = questions.slice(i, i + MAX_QUESTIONS_PER_BATCH);
        const batchRowData = rowData.slice(i, i + MAX_QUESTIONS_PER_BATCH);
        const batchResultsPart = await processQuestions(batchQuestions, batchRowData);
        batchResults.push(...batchResultsPart);
        console.log(`Processed batch ${i / MAX_QUESTIONS_PER_BATCH + 1}`);
      }
      results = batchResults;
    } else {
      results = await processQuestions(questions, rowData);
    }

    const newData = [data[0]];
    const uniqueResults = results.filter(result => !result.isDuplicate);
    
    uniqueResults.forEach(result => {
      const originalRowIndex = results.indexOf(result);
      if (originalRowIndex !== -1) {
        newData.push(data[originalRowIndex + 1]);
      }
    });

    const newWorkbook = xlsx.utils.book_new();
    const newWorksheet = xlsx.utils.json_to_sheet(newData, { skipHeader: true });
    xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, "Unique Questions");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const originalFilename = path.basename(filePath);
    const cleanedFilename = `cleaned_${timestamp}_${originalFilename}`;
    const cleanedFilePath = path.join(path.dirname(filePath), cleanedFilename);
    
    xlsx.writeFile(newWorkbook, cleanedFilePath);

    console.log(`Excel processing complete. Generated: ${cleanedFilename}`);
    return {
      results,
      cleanedFilePath: cleanedFilename,
      stats: {
        totalQuestions: results.length,
        duplicatesFound: results.filter(r => r.isDuplicate).length,
        uniqueQuestions: uniqueResults.length,
        geminiUsage: similarityCache.size,
        apiCallCount,
        apiFailures,
        fallbackCount
      }
    };
  } catch (err) {
    console.error("Excel processing error:", err);
    throw new Error(`Error processing Excel file: ${err.message}`);
  }
}

// API endpoint to reset questions JSON file
app.post("/reset-questions", async (req, res) => {
  try {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions: [] }, null, 2));
    similarityCache.clear();
    apiCallCount = 0;
    apiFailures = 0;
    fallbackCount = 0;
    res.json({ 
      success: true,
      message: "Questions database has been reset successfully"
    });
  } catch (error) {
    console.error("Error resetting questions file:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// API endpoint for batch processing
app.post("/check-batch", async (req, res) => {
  try {
    const { questions } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: "Questions array is required" });
    }

    if (questions.length > MAX_QUESTIONS_PER_BATCH) {
      return res.status(400).json({ 
        error: `Maximum ${MAX_QUESTIONS_PER_BATCH} questions per batch allowed` 
      });
    }

    const startTime = Date.now();
    const results = await processQuestions(questions);
    
    res.json({ 
      success: true,
      results,
      stats: {
        totalQuestions: questions.length,
        duplicatesFound: results.filter(r => r.isDuplicate).length,
        processingTime: `${(Date.now() - startTime) / 1000} seconds`,
        geminiUsage: similarityCache.size,
        apiCallCount,
        apiFailures,
        fallbackCount
      }
    });
  } catch (error) {
    console.error("Error processing questions:", error);
    res.status(400).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// API endpoint for file uploads
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: "No file uploaded" 
      });
    }

    const startTime = Date.now();
    const { results, cleanedFilePath, stats } = await processExcelFile(req.file.path);

    await fs.unlink(req.file.path).catch(console.error);

    res.json({
      success: true,
      results,
      cleanedFilePath,
      stats: {
        ...stats,
        processingTime: `${(Date.now() - startTime) / 1000} seconds`
      }
    });
  } catch (error) {
    console.error("Error processing file:", error);
    if (req.file) {
      fs.unlink(req.file.path).catch(console.error);
    }
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// API endpoint for file downloads
app.get("/download/:filename", async (req, res) => {
  try {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    await fs.access(filePath);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.filename}`);
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    fileStream.on('end', () => {
      fs.unlink(filePath).catch(console.error);
    });
  } catch (err) {
    console.error("Download error:", err);
    res.status(404).send("File not found");
  }
});

// Debug endpoint for testing question pairs
app.post("/debug", async (req, res) => {
  try {
    const { question1, question2 } = req.body;
    if (!question1 || !question2) {
      return res.status(400).json({ error: "Two questions are required" });
    }

    const prompt = `Return only a raw JSON object (no Markdown, no code fences) analyzing the similarity between:
    Question 1: "${question1}"
    Question 2: "${question2}"
    Format:
    {
      "similarityScore": number,
      "isSameQuestion": boolean,
      "reasons": string[],
      "analysis": string
    }
    Ensure all strings are properly escaped and the response is valid JSON.`;

    const result = await model.generateContent(prompt);
    let text = (await result.response.text()).trim();
    text = text.replace(/```json\n|```/g, '');
    const jsonString = sanitizeJsonString(text);
    const parsed = JSON.parse(jsonrepair(jsonString));

    res.json({
      success: true,
      rawResponse: text,
      sanitizedResponse: jsonString,
      parsedResponse: parsed
    });
  } catch (error) {
    console.error("Debug endpoint error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      rawResponse: error.response ? error.response.text : null
    });
  }
});

// Stats endpoint for monitoring
app.get("/stats", (req, res) => {
  res.json({
    apiCallCount,
    apiFailures,
    fallbackCount,
    cacheSize: similarityCache.size,
    rateLimit: {
      reservoir: limiter.reservoir,
      maxConcurrent: limiter.maxConcurrent,
      requestsPerMinute: GEMINI_REQUESTS_PER_MINUTE
    },
    uptime: process.uptime()
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    version: "2.0.6",
    features: ["gemini-flash-integration", "semantic-analysis", "optimized-rate-limiting", "json-sanitization", "enhanced-logging", "robust-json-parsing", "debug-endpoint", "json-repair"],
    uptime: process.uptime(),
    geminiModel: GEMINI_MODEL_NAME,
    stats: {
      apiCallCount,
      apiFailures,
      fallbackCount,
      cacheSize: similarityCache.size
    }
  });
});

// Initialize and start server
initialize().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using Gemini model: ${GEMINI_MODEL_NAME}`);
    console.log(`Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    console.log(`Max questions per batch: ${MAX_QUESTIONS_PER_BATCH}`);
    console.log(`Gemini rate limit: ${GEMINI_REQUESTS_PER_MINUTE} requests/minute`);
  });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});